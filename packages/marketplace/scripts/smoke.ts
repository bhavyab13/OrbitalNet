/** Smoke test: connect over Streamable HTTP, list tools, discover, plan, (optionally) reserve+submit+poll. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const FULL = process.env.FULL === "1";
const client = new Client({ name: "orbitalnet-smoke", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_)));
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const res = await client.listResources(); console.log("resources:", res.resources.map((r) => r.uri).join(", "));
const pr = await client.listPrompts(); console.log("prompts:", pr.prompts.map((p) => p.name).join(", "));
const call = async (name: string, args: any) => { const r: any = await client.callTool({ name, arguments: args }); if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`); return r.structuredContent ?? r; };

if (process.env.RESET === "1") console.log("reset:", await call("reset_world", {}));
const disc = await call("discover_providers", {});
console.log(`providers (${disc.count}):`, disc.providers.map((p: any) => `${p.operator_id}/${p.node_id} verified=${p.verified}`).join(", "));
const win = await call("get_contact_windows", {}); console.log("windows:", win.windows.length, "sim_t", win.sim_t);
const plan = await call("plan_mission", { mission_id: "fire-001", ...(process.env.BUDGET ? { budget_usd: Number(process.env.BUDGET) } : {}) });
console.log(`\nPLANS (now T+${plan.now_sim_t}s, deadline T+${plan.deadline_sim_t}s, budget $${plan.budget_remaining_usd.toFixed(2)}, quotes ${plan.quotes.length}${plan.quote_errors.length ? ", errors: " + plan.quote_errors.join("; ") : ""})`);
console.table(plan.plans.map((p: any) => ({ plan: p.plan_id, feasible: p.feasible, delivery: p.delivery_sim_t == null ? "—" : `T+${Math.round(p.delivery_sim_t)}s`, cost: `$${p.cost_usd.toFixed(2)}`, legs: p.legs.length, reasons: p.reasons.join("; ").slice(0, 60) })));
for (const p of plan.plans) console.log(" -", p.explanation);
const best = plan.plans.filter((p: any) => p.feasible).sort((a: any, b: any) => a.cost_usd - b.cost_usd)[0];
if (!FULL || !best) { console.log(best ? "\n(FULL=1 to reserve+submit)" : "\nno feasible plan"); process.exit(0); }
const r = await call("reserve_path", { mission_id: "fire-001", plan_id: best.plan_id });
console.log("\nreserve:", r.ok ? `ok $${r.total_usd.toFixed(2)} grants=${r.grants.length}` : `FAILED ${r.reason}`, r.receipts);
if (!r.ok) process.exit(1);
console.log("submit:", await call("submit_mission", { mission_id: "fire-001", plan_id: best.plan_id }));
for (let i = 0; i < 200; i++) {
  const s = await call("get_mission_status", { mission_id: "fire-001" });
  console.log(`  [${i}] ${s.status} T+${s.sim_t}s leg ${s.current_leg} ${s.legs.map((l: any) => l.status?.[0] ?? "?").join("")} ${s.last_event ?? ""}`);
  if (s.status === "DELIVERED" || s.status === "INFEASIBLE" || s.status === "FAILED") { console.log("final:", JSON.stringify(s.result?.summary ?? s.status)); break; }
  if (s.status === "REPLAN_REQUIRED") {
    const p2 = await call("plan_mission", { mission_id: "fire-001", ...(s.committed ? { preserve: s.committed } : {}), ...(process.env.BUDGET ? { budget_usd: Number(process.env.BUDGET) } : {}) });
    const b2 = p2.plans.filter((p: any) => p.feasible)[0]; if (!b2) { console.log("replan: INFEASIBLE", p2.plans.map((p: any) => p.reasons)); break; }
    const r2 = await call("reserve_path", { mission_id: "fire-001", plan_id: b2.plan_id }); console.log("replan reserve:", r2.ok, r2.reason);
    if (r2.ok) console.log("resume:", await call("submit_mission", { mission_id: "fire-001", plan_id: b2.plan_id, resume: true }));
  }
  await new Promise((r) => setTimeout(r, 2000));
}
await client.close();
