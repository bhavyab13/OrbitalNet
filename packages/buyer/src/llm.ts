/**
 * LLM buyer: Claude drives the OCGP marketplace through MCP tools.
 * The LLM interprets the mission, chooses among planner-verified feasible plans,
 * and narrates decisions. Deterministic code (planner, operators) enforces constraints.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Broker } from "./mcp.js";
import { narrate, sleep } from "./narrate.js";

const MODEL = process.env.BUYER_MODEL ?? "claude-opus-5-5";

const SYSTEM = `You are the autonomous procurement agent for an emergency-response organisation, operating on the OrbitalNet marketplace (OCGP protocol).
You buy orbital compute and relay capacity from independently operated satellites so a time-critical mission can be delivered before its deadline and under budget.

How to work:
1. discover_providers → get_contact_windows → plan_mission (the planner only marks plans feasible if bytes fit the contact windows, compute fits, delivery is before the deadline and cost is within budget; trust it).
2. Choose among FEASIBLE plans. Prefer earliest delivery; break ties on cost. Explain the choice in one or two sentences, citing why the alternatives failed (deadline, bytes, budget).
3. reserve_path for the chosen plan (this pays each provider with MPP and collects signed grants). If it fails, no money moved: replan.
4. submit_mission, then wait_for_mission_event. On REPLAN_REQUIRED: the state tells you which work is already committed and what was refunded; run plan_mission again with preserve set and only buy the remaining legs. On DELIVERED or INFEASIBLE: stop.
5. If NO plan is feasible but the deadline has not passed, do not give up: call wait_for_new_provider (providers can join the marketplace at any time with self-describing signed manifests), then plan_mission again. Declare INFEASIBLE only when the deadline passes.
Rules: never claim delivery unless status is DELIVERED. If nothing is feasible say so plainly. Keep every message short: it is shown live on a mission-control screen. Do not call get_mission_status in a loop; use wait_for_mission_event.`;

export async function runLLM(broker: Broker, mission: any) {
  const client = new Anthropic();
  const mission_id = mission.mission_id;

  const tools: Anthropic.Tool[] = broker.tools.map((t) => ({
    name: t.name, description: t.description ?? t.name,
    input_schema: (t.inputSchema ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
  }));
  tools.push({
    name: "wait_for_mission_event",
    description: "Blocks until the mission reaches DELIVERED, INFEASIBLE, FAILED or REPLAN_REQUIRED (or 10 minutes pass) and returns the mission status, including committed work and refunds.",
    input_schema: { type: "object", properties: { mission_id: { type: "string" } }, required: ["mission_id"] },
  });

  tools.push({
    name: "wait_for_new_provider",
    description: "Blocks until the set of online providers changes (a new operator registers) or the mission deadline passes. Returns the new provider list and the current sim time.",
    input_schema: { type: "object", properties: { deadline_sim_t: { type: "number" } }, required: ["deadline_sim_t"] },
  });

  const exec = async (name: string, input: any): Promise<string> => {
    if (name === "wait_for_new_provider") {
      const d0: any = await broker.call("discover_providers", {});
      const n0 = (d0.providers ?? []).filter((p: any) => p.online !== false).length;
      await narrate(`No feasible path with ${n0} providers online. Watching the marketplace for new capacity until T+${input.deadline_sim_t}s.`, "waiting");
      for (;;) {
        await sleep(3000);
        const st: any = await broker.call("get_contact_windows", {});
        if (Number(st.sim_t ?? 0) >= input.deadline_sim_t) return JSON.stringify({ event: "deadline_passed", sim_t: st.sim_t });
        const d: any = await broker.call("discover_providers", {});
        const online = (d.providers ?? []).filter((p: any) => p.online !== false);
        if (online.length !== n0) return JSON.stringify({ event: "providers_changed", sim_t: st.sim_t, providers: online });
      }
    }
    if (name === "wait_for_mission_event") {
      for (let i = 0; i < 300; i++) {
        await sleep(2000);
        const st: any = await broker.call("get_mission_status", { mission_id: input.mission_id ?? mission_id });
        const s = st.status ?? st.mission?.status;
        if (["DELIVERED", "INFEASIBLE", "FAILED", "REPLAN_REQUIRED"].includes(s)) return JSON.stringify(st);
      }
      return JSON.stringify({ status: "TIMEOUT" });
    }
    const out = await broker.call(name, input ?? {});
    return typeof out === "string" ? out : JSON.stringify(out);
  };

  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: `New mission ${mission_id}.\n${mission.text}\nParameters: ${JSON.stringify({
      source_node: mission.source_node, payload_mb: mission.payload_mb, op: mission.op, model: mission.model,
      result_mb_estimate: mission.result_mb_estimate, deadline_sim_t: mission.deadline_sim_t, budget_usd: mission.budget_usd, holder: mission.buyer_id,
    })}\nProcure a deadline-feasible path, execute it, and see it through to delivery.`,
  }];
  await narrate(`Mission ${mission_id} received. Reading provider manifests…`, "arrival");

  for (let turn = 0; turn < 40; turn++) {
    const response = await client.beta.messages.create({
      model: MODEL, max_tokens: 16000, system: SYSTEM, tools, messages,
      thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" },
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    } as any);

    for (const block of response.content) if (block.type === "text" && block.text.trim()) await narrate(block.text.trim(), "buyer");

    if (response.stop_reason === "refusal") { await narrate("Model declined the request.", "error"); break; }
    if (response.stop_reason === "max_tokens") { await narrate("Hit max_tokens; stopping.", "error"); break; }
    messages.push({ role: "assistant", content: response.content as any });
    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason !== "tool_use") break;

    const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      let content: string; let is_error = false;
      try { content = await exec(u.name, u.input); } catch (e: any) { content = `ERROR: ${e.message}`; is_error = true; }
      console.log(`  ↳ ${u.name}(${JSON.stringify(u.input).slice(0, 120)}) → ${content.slice(0, 160)}…`);
      results.push({ type: "tool_result", tool_use_id: u.id, content, is_error });
    }
    messages.push({ role: "user", content: results });
  }
}
