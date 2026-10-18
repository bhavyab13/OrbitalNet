/**
 * OpenAI-backed buyer (used when only OPENAI_API_KEY is available). Same protocol flow as llm.ts:
 * the model reads the mission intent, drives the OCGP marketplace through MCP tools, and narrates.
 * Spend is kept minimal: a small model, low reasoning effort, short outputs, and all waiting done
 * locally (wait_for_mission_event / wait_for_new_provider) instead of by polling tool calls.
 */
import { Broker } from "./mcp.js";
import { narrate, sleep } from "./narrate.js";

const MODEL = process.env.BUYER_MODEL ?? "gpt-4.1-mini"; // cheap, no hidden reasoning tokens; set BUYER_MODEL=gpt-5-mini for a reasoning model
const API = "https://api.openai.com/v1/chat/completions";

const SYSTEM = `You are the autonomous procurement agent for an emergency-response organisation on the OrbitalNet marketplace (OCGP protocol). You buy orbital compute and relay capacity from independently operated satellites so a time-critical mission is delivered before its deadline and under budget.
Flow: discover_providers → plan_mission (the planner marks plans feasible only if bytes fit contact windows, delivery is before the deadline and cost fits budget; trust it) → choose → reserve_path (pays via MPP, collects signed grants; if it fails nothing was paid, replan) → submit_mission → wait_for_mission_event. On REPLAN_REQUIRED, re-run plan_mission with preserve from the status (committed work) and buy only the remaining legs, then submit_mission with resume=true. If nothing is feasible and the deadline has not passed, call wait_for_new_provider then plan again. Stop on DELIVERED or INFEASIBLE.
Choose among FEASIBLE plans by the mission's INTENT, not a fixed rule: plans differ in delivery time, cost and fidelity ("full" = on-orbit analysis with fire-front perimeters; "low" = downsampled raw crop, extent only). Urgent responder wording → speed and full fidelity. Budget wording ("under $X", "rough extent") → the cheap low-fidelity crop if it meets the deadline. Archival wording → cheapest full fidelity even if late, if the deadline allows. Never violate a stated required fidelity.
Style: every message is shown live on a mission-control screen. Two sentences maximum per message: what the mission needs, which plan you chose, what you rejected and why. Never claim delivery unless status is DELIVERED. Do not poll get_mission_status in a loop.`;

type Msg = { role: string; content: string | null; tool_calls?: any[]; tool_call_id?: string; name?: string };

export async function runOpenAI(broker: Broker, mission: any) {
  const key = process.env.OPENAI_API_KEY!;
  const mission_id = mission.mission_id;
  const tools: any[] = broker.tools.map((t) => ({ type: "function", function: { name: t.name, description: (t.description ?? t.name).slice(0, 1024), parameters: t.inputSchema ?? { type: "object", properties: {} } } }));
  tools.push({ type: "function", function: { name: "wait_for_mission_event", description: "Blocks until the mission reaches DELIVERED, INFEASIBLE, FAILED or REPLAN_REQUIRED and returns the status (with committed work and refunds).", parameters: { type: "object", properties: { mission_id: { type: "string" } }, required: ["mission_id"] } } });
  tools.push({ type: "function", function: { name: "wait_for_new_provider", description: "Blocks until a new provider comes online or the deadline passes. Returns the providers and sim time.", parameters: { type: "object", properties: { deadline_sim_t: { type: "number" } }, required: ["deadline_sim_t"] } } });

  const compact = (name: string, out: any): string => {
    // Trim large payloads before they enter the context (thumbnails, geojson, audit) to keep token spend low.
    const strip = (o: any, depth = 0): any => {
      if (Array.isArray(o)) return o.slice(0, 12).map((x) => strip(x, depth + 1));
      if (o && typeof o === "object") { const r: any = {}; for (const [k, v] of Object.entries(o)) { if (["thumbnail_b64", "geojson", "sig", "public_key", "manifest", "legs_detail", "events_tail"].includes(k)) continue; if (k === "audit" && Array.isArray(v)) { r[k] = `${v.length} entries`; continue; } r[k] = strip(v, depth + 1); } return r; }
      if (typeof o === "string" && o.length > 300) return o.slice(0, 300) + "…";
      return o;
    };
    const s = JSON.stringify(strip(out));
    return s.length > 6000 ? s.slice(0, 6000) + "…(truncated)" : s;
  };

  const exec = async (name: string, input: any): Promise<string> => {
    if (name === "wait_for_mission_event") {
      for (let i = 0; i < 300; i++) { await sleep(2000); const st: any = await broker.call("get_mission_status", { mission_id: input.mission_id ?? mission_id }); const s = st.status ?? st.mission?.status; if (["DELIVERED", "INFEASIBLE", "FAILED", "REPLAN_REQUIRED"].includes(s)) return compact(name, st); }
      return JSON.stringify({ status: "TIMEOUT" });
    }
    if (name === "wait_for_new_provider") {
      const d0: any = await broker.call("discover_providers", {}); const n0 = (d0.providers ?? []).filter((p: any) => p.online !== false).length;
      await narrate(`No feasible path with ${n0} providers online. Watching the marketplace for new capacity until T+${input.deadline_sim_t}s.`, "waiting");
      for (;;) { await sleep(3000); const st: any = await broker.call("get_contact_windows", {}); if (Number(st.sim_t ?? 0) >= input.deadline_sim_t) return JSON.stringify({ event: "deadline_passed", sim_t: st.sim_t }); const d: any = await broker.call("discover_providers", {}); const online = (d.providers ?? []).filter((p: any) => p.online !== false); if (online.length !== n0) return compact(name, { event: "providers_changed", sim_t: st.sim_t, providers: online.map((p: any) => ({ operator_id: p.operator_id, node_id: p.node_id, verified: p.verified })) }); }
    }
    return compact(name, await broker.call(name, input ?? {}));
  };

  const messages: Msg[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `New mission ${mission_id}.\n${mission.text}\nParameters: ${JSON.stringify({ source_node: mission.source_node, payload_mb: mission.payload_mb, op: mission.op, model: mission.model, result_mb_estimate: mission.result_mb_estimate, deadline_sim_t: mission.deadline_sim_t, budget_usd: mission.budget_usd, holder: mission.buyer_id, required_fidelity: mission.required_fidelity ?? "any" })}\nProcure a deadline-feasible path, execute it, and see it through to delivery.` },
  ];
  await narrate(`Mission ${mission_id} received. Reading provider manifests…`, "arrival");
  let usage = { prompt: 0, completion: 0 };

  for (let turn = 0; turn < 40; turn++) {
    const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", max_completion_tokens: MODEL.startsWith("gpt-5") ? 1500 : 500, ...(MODEL.startsWith("gpt-5") ? { reasoning_effort: "low" } : { temperature: 0.2 }) }) });
    if (!res.ok) { const t = await res.text(); await narrate(`LLM error ${res.status}: ${t.slice(0, 200)}`, "error"); throw new Error(t); }
    const data: any = await res.json();
    usage.prompt += data.usage?.prompt_tokens ?? 0; usage.completion += data.usage?.completion_tokens ?? 0;
    const msg = data.choices?.[0]?.message; if (!msg) break;
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
    if (msg.content && msg.content.trim()) await narrate(msg.content.trim(), "buyer");
    if (!msg.tool_calls?.length) break;
    for (const tc of msg.tool_calls) {
      let input: any = {}; try { input = JSON.parse(tc.function.arguments || "{}"); } catch { input = {}; }
      let content: string; try { content = await exec(tc.function.name, input); } catch (e: any) { content = `ERROR: ${e.message}`; }
      console.log(`  ↳ ${tc.function.name}(${JSON.stringify(input).slice(0, 100)}) → ${content.slice(0, 120)}…`);
      messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content });
    }
  }
  console.log(`[openai] model=${MODEL} tokens prompt=${usage.prompt} completion=${usage.completion}`);
}
