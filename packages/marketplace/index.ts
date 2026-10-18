/**
 * OrbitalNet Marketplace — the OCGP Broker as an MCP server (mcp-use v2 / Manufact Cloud).
 * Tools let any agent discover independent satellite operators, get signed quotes, plan a
 * deadline-feasible path, commit payments (MPP) for signed capacity grants, run the mission
 * in the world simulator and watch it live via an MCP App view.
 */
import fs from "node:fs";
import { MCPServer } from "mcp-use";
import { z } from "zod";
import { env, PROTOCOL_MD, SCENARIO_JSON, scenario } from "./src/config.js";
import * as registry from "./src/registry.js";
import { simFetch, emit } from "./src/sim.js";
import * as broker from "./src/broker.js";
import { streamTransfer } from "./src/stream.js";
import { brokerWallet, getPayFetch } from "./src/pay.js";

const server = new MCPServer({
  name: "orbitalnet-marketplace",
  title: "OrbitalNet Marketplace",
  version: "0.1.0",
  description: "Broker for the OrbitalNet Capacity Grant Protocol (OCGP): buy deadline-feasible satellite compute + relay capacity from independent operators with machine payments.",
  instructions: [
    "You are driving a marketplace of independently operated satellites. Flow: discover_providers -> get_contact_windows -> plan_mission (quotes are gathered for you) ->",
    "pick ONE feasible plan (trade cost vs delivery time) -> reserve_path (pays each operator via MPP, returns signed grants) -> submit_mission -> poll get_mission_status every few seconds.",
    "If status becomes REPLAN_REQUIRED, call plan_mission again with preserve={node_id,result_mb} from the status's `committed` field, then reserve_path + submit_mission with resume=true.",
    "If no plan is feasible, say so honestly (INFEASIBLE) — never pretend delivery. Read resource ocgp://protocol for the rules.",
  ].join(" "),
  websiteUrl: "https://github.com/orbitalnet",
  icons: [{ src: "icon.svg", mimeType: "image/svg+xml", sizes: ["512x512"] }],
});

// ---------- plain HTTP routes (registry + health) ----------
server.get("/health", (c) => c.json({ ok: true, sim: env.SIM_URL, mock_sim: env.MOCK_SIM, providers: registry.list().length, wallet: brokerWallet() ?? null }));
server.get("/registry", (c) => c.json({ providers: registry.list().map(({ manifest, ...e }) => ({ ...e, manifest })) }));
server.post("/reset", async (c) => { const r = await simFetch("/reset", { method: "POST", json: {} }).catch(() => ({ ok: false })); broker.missions.clear(); return c.json({ ok: true, world: Boolean(r?.ok ?? true) }); });
// OCGP §2.10: the world runner asks the broker to carry a relay downlink as a metered MPP session (pay per 100 KB as bytes flow).
server.post("/transfer/stream", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  for (const k of ["mission_id", "operator_id", "grant", "world_assertion", "payload_b64", "bytes_mb"]) if (body[k] === undefined) return c.json({ ok: false, reason: `${k} required` }, 400);
  const r = await streamTransfer(body);
  return c.json(r, r.ok ? 200 : 409);
});
server.post("/registry", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const url = body.manifest_url ?? body.base_url;
  if (!url) return c.json({ ok: false, error: "manifest_url required" }, 400);
  try { const e = await registry.register(url); emit({ type: "provider_online", operator_id: e.operator_id, node_id: e.node_id, verified: e.verified }); return c.json({ ok: true, operator_id: e.operator_id, node_id: e.node_id, verified: e.verified }); }
  catch (err: any) { return c.json({ ok: false, error: String(err?.message ?? err) }, 502); }
});

// ---------- resource + prompt ----------
server.resource({ name: "OCGP protocol specification", uri: "ocgp://protocol", title: "OrbitalNet Capacity Grant Protocol", description: "The rules of the marketplace: manifests, quotes, holds, grants, world assertions, attestations, replanning.", mimeType: "text/markdown" },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: PROTOCOL_MD ? fs.readFileSync(PROTOCOL_MD, "utf8") : "PROTOCOL.md not bundled" }] }));
server.resource({ name: "Demo scenario", uri: "ocgp://scenario", title: "Canonical demo scenario", mimeType: "application/json" },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: SCENARIO_JSON ? fs.readFileSync(SCENARIO_JSON, "utf8") : "{}" }] }));
server.prompt({ name: "run_mission", title: "Run an OrbitalNet mission end-to-end", description: "Instructs an agent to buy and execute a deadline-feasible satellite mission.", schema: z.object({ mission_text: z.string().optional().describe("Natural-language mission; defaults to the demo wildfire mission") }) },
  async ({ mission_text }) => ({ messages: [{ role: "user", content: { type: "text", text:
`Mission: ${mission_text ?? scenario.mission?.text ?? "Deliver the wildfire assessment before the deadline."}
Use the OrbitalNet Marketplace tools in this order: discover_providers, get_contact_windows, plan_mission, then choose ONE feasible plan explaining the trade-off (cost vs delivery time vs fidelity), reserve_path, submit_mission, and poll get_mission_status until DELIVERED or INFEASIBLE. On REPLAN_REQUIRED re-plan with preserve from the status and resume. Report the audit: grants, receipts, attestations, bytes moved, total paid.` } }] }));

// ---------- schemas ----------
const Any = z.any();
const Manifest = z.object({ operator_id: z.string(), operator_name: z.string().optional(), node_id: z.string(), base_url: z.string(), verified: z.boolean().describe("Manifest signature verified with the operator's own Ed25519 key"), online: z.boolean(), capabilities: z.array(Any), policy: Any.optional(), payment: Any.optional(), capacity: Any.optional(), public_key: z.string().optional(), kid: z.string().optional() }).passthrough();
const Window = z.object({ window_id: z.string(), from: z.string(), to: z.string(), start: z.number(), end: z.number(), bandwidth_mbps: z.number(), kind: z.string().optional(), status: z.string().optional(), remaining_mb: z.number().optional(), note: z.string().optional() }).passthrough();
const Leg = z.object({ kind: z.enum(["transfer", "compute"]), from: z.string().nullish(), to: z.string().nullish(), node: z.string().nullish(), window_id: z.string(), start: z.number(), end: z.number(), bytes_mb: z.number(), duration_s: z.number().nullish(), quote_id: z.string().nullish(), price_usd: z.number().nullish(), operator_id: z.string().nullish(), node_id: z.string().nullish(), capability: z.string().nullish() }).passthrough();
const Plan = z.object({ plan_id: z.string(), label: z.string(), legs: z.array(Leg), delivery_sim_t: z.number().nullish(), cost_usd: z.number(), feasible: z.boolean(), reasons: z.array(z.string()), explanation: z.string().nullish() }).passthrough();
const Quote = z.object({ quote_id: z.string(), operator_id: z.string(), node_id: z.string(), capability: z.string(), window_id: z.string(), units: z.record(z.string(), z.number()), price_usd: z.number(), expires_sim_t: z.number().optional() }).passthrough();
const Grant = z.object({ grant_id: z.string(), mission_id: z.string(), operator_id: z.string(), node_id: z.string(), capability: z.string(), window_id: z.string(), price_usd: z.number().optional() }).passthrough();
const Payment = z.object({ operator_id: z.string(), node_id: z.string(), amount_usd: z.number(), method: z.string().optional(), receipt_ref: z.string().optional(), grant_id: z.string().optional(), ts: z.string() });
const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

// ---------- tools ----------
// Every tool call is announced to the world (dashboard "Manufact MCP · call from <client>" stamp + analytics narrative).
{
  const _tool = (server as any).tool.bind(server);
  (server as any).tool = (def: any, handler: any) => _tool(def, async (input: any, ctx: any) => {
    let client = "MCP client";
    try { const info = ctx?.client?.info?.(); client = info?.name ? `${info.name}${info.version ? "/" + info.version : ""}` : client; } catch { /* unverified client metadata */ }
    // Announce decision-making calls only (polling tools would flood the feed).
    if (!["get_mission_status", "get_contact_windows", "request_quotes"].includes(def.name)) {
      try { emit({ type: "mcp_client_call", tool: def.name, client, mission_id: input?.mission_id }); } catch { /* sim offline */ }
    }
    return handler(input, ctx);
  });
}

export const discoverProviders = server.tool({
  name: "discover_providers", title: "Discover providers",
  description: "List independently operated satellite providers currently registered with the marketplace, with their signed self-describing manifests (capabilities, limits, prices, policy, payment methods) and live capacity. Use this first. A provider that boots later shows up automatically.",
  inputSchema: z.object({ capability: z.enum(["compute", "relay"]).optional().describe("Only providers offering this capability"), include_offline: z.boolean().optional().describe("Include providers whose manifest is currently unreachable (default false)") }),
  outputSchema: z.object({ providers: z.array(Manifest), count: z.number() }), annotations: ro,
}, async ({ capability, include_offline }) => {
  await registry.crawl();
  const providers = registry.list().filter((e) => (include_offline || e.online) && (!capability || e.manifest.capabilities.some((c) => c.type === capability)))
    .map((e) => ({ operator_id: e.operator_id, operator_name: e.manifest.operator_name, node_id: e.node_id, base_url: e.base_url, verified: e.verified, trusted: e.trusted, untrusted_reason: e.untrusted_reason ?? null, online: e.online, capabilities: e.manifest.capabilities, policy: e.manifest.policy, payment: e.manifest.payment, capacity: e.manifest.capacity, public_key: e.manifest.public_key, kid: e.manifest.kid }));
  const data = { providers, count: providers.length };
  return { content: [{ type: "text", text: providers.length ? providers.map((p) => `${p.operator_id} (${p.node_id}) ${p.verified ? "✓verified" : "✗UNVERIFIED"}${p.trusted ? "" : " ⚠UNTRUSTED(" + p.untrusted_reason + ")"} caps=${p.capabilities.map((c: any) => c.type).join(",")} @ ${p.base_url}`).join("\n") : "No providers registered yet." }], structuredContent: data };
});

export const getContactWindows = server.tool({
  name: "get_contact_windows", title: "Get contact windows",
  description: "Contact windows (crosslinks and ground-station downlinks) from the world simulator with live status (future/open/closed/killed) and remaining capacity. Times are sim seconds from the scenario epoch.",
  inputSchema: z.object({ node_ids: z.array(z.string()).optional().describe("Restrict to windows touching any of these node ids") }),
  outputSchema: z.object({ sim_t: z.number(), windows: z.array(Window) }), annotations: ro,
}, async ({ node_ids }) => {
  const [st, w] = await Promise.all([simFetch("/state"), simFetch("/windows")]);
  let windows: any[] = Array.isArray(w) ? w : (w.windows ?? []);
  if (node_ids?.length) windows = windows.filter((x) => node_ids.includes(x.from) || node_ids.includes(x.to));
  const data = { sim_t: Number(st.sim_t ?? 0), windows };
  return { content: [{ type: "text", text: `sim_t=${data.sim_t}\n` + windows.map((x) => `${x.window_id}: ${x.from}→${x.to} [${x.start},${x.end}] ${x.bandwidth_mbps} Mbps ${x.status ?? ""}`).join("\n") }], structuredContent: data };
});

export const requestQuotes = server.tool({
  name: "request_quotes", title: "Request quotes",
  description: "Ask specific providers for signed, window-bound quotes. Usually unnecessary: plan_mission gathers quotes automatically. Use for manual negotiation or to re-price after a disruption.",
  inputSchema: z.object({ mission_id: z.string(), legs: z.array(z.object({ node_id: z.string().describe("Provider's node id, e.g. PHISAT-2"), capability: z.enum(["compute", "relay"]), window_id: z.string(), units: z.record(z.string(), z.number()).describe("{mb: n} for relay, {compute_s: n, mb: n} for compute") })) }),
  outputSchema: z.object({ quotes: z.array(Quote), errors: z.array(z.string()) }), annotations: ro,
}, async ({ mission_id, legs }) => {
  const now = await simFetch("/state").then((s: any) => Number(s.sim_t ?? 0)).catch(() => 0);
  const quotes: any[] = []; const errors: string[] = [];
  for (const l of legs) { const e = registry.byNode(l.node_id); if (!e) { errors.push(`no provider for ${l.node_id}`); continue; } const q = await broker.requestQuote(mission_id, e, l.capability, l.window_id, l.units, now).catch((err) => ({ error: String(err?.message ?? err) })); if ("error" in q) errors.push(q.error); else quotes.push(q); }
  return { content: [{ type: "text", text: quotes.map((q) => `${q.operator_id} ${q.capability} ${q.window_id}: $${q.price_usd.toFixed(2)}`).join("\n") + (errors.length ? "\nerrors: " + errors.join("; ") : "") }], structuredContent: { quotes, errors } };
});

export const planMission = server.tool({
  name: "plan_mission", title: "Plan mission",
  description: "Compute every candidate end-to-end path (own downlink, raw relay, remote inference + relay, ...) for a mission, gather signed quotes from each independent provider, and return ALL candidates with feasibility, delivery time, cost and a plain-English explanation. Infeasible plans include the physical/economic reason. Defaults come from the demo scenario; pass preserve={node_id,result_mb} when re-planning after a disruption so already-computed results are reused.",
  inputSchema: z.object({
    mission_id: z.string().describe("Mission id, e.g. fire-001"),
    source_node: z.string().optional().describe("Node currently holding the data (default: scenario source)"),
    payload_mb: z.number().optional().describe("Size of the raw data in MB"),
    op: z.string().optional().describe("Processing op required, e.g. image-inference; omit for pure delivery"),
    model: z.string().optional(), result_mb_estimate: z.number().optional().describe("Expected size of the processed result in MB"),
    deadline_sim_t: z.number().optional().describe("Deadline in sim seconds"), budget_usd: z.number().optional(),
    now_sim_t: z.number().optional().describe("Override current sim time (default: live)"),
    preserve: z.object({ node_id: z.string(), result_mb: z.number() }).optional().describe("Re-plan from a node that already holds the computed result"),
    exclude_windows: z.array(z.string()).optional().describe("Window ids to avoid (e.g. a killed link)"),
    required_fidelity: z.enum(["full", "low", "any"]).optional().describe("'full' = on-orbit analysis with fire-front perimeters required; 'low' = a downsampled raw crop is acceptable; 'any' (default) lets the buyer choose by intent"),
    text: z.string().optional().describe("The mission owner's own words; stored with the mission and shown on the mission-control screen"),
  }),
  outputSchema: z.object({ mission_id: z.string(), now_sim_t: z.number(), deadline_sim_t: z.number(), budget_remaining_usd: z.number(), plans: z.array(Plan), quotes: z.array(Quote), quote_errors: z.array(z.string()) }), annotations: ro,
}, async (input) => {
  const r0 = await broker.planMission(input);
  const r = { ...r0, now_sim_t: Number(r0.now_sim_t ?? 0), deadline_sim_t: Number(r0.deadline_sim_t ?? 0), budget_remaining_usd: Number(r0.budget_remaining_usd ?? 0) };
  const table = r.plans.map((p) => `${p.feasible ? "✓" : "✗"} ${p.plan_id} — ${p.label}: ${p.feasible ? `T+${Math.round(p.delivery_sim_t ?? 0)}s, $${p.cost_usd.toFixed(2)}` : p.reasons.join("; ")}`).join("\n");
  return { content: [{ type: "text", text: `now=T+${r.now_sim_t}s deadline=T+${r.deadline_sim_t}s budget=$${r.budget_remaining_usd.toFixed(2)}\n${table}` }], structuredContent: r };
});

export const reservePath = server.tool({
  name: "reserve_path", title: "Reserve path (pay + grants)",
  description: "Commit to one feasible plan: place holds on every leg with every operator, and only if ALL holds succeed pay each operator (MPP machine payment from the broker wallet) and collect signed, window-bound capacity grants (OCGP). If any hold fails nothing is paid. Returns grants, payment receipts and the total charged.",
  inputSchema: z.object({ mission_id: z.string(), plan_id: z.string().describe("plan_id from plan_mission"), holder: z.string().optional().describe("Identity the grants are issued to (default buyer:emergency-ops)") }),
  outputSchema: z.object({ ok: z.boolean(), reason: z.string(), plan_id: z.string().optional(), grants: z.array(Grant), receipts: z.array(Payment), total_usd: z.number() }), annotations: rw,
}, async ({ mission_id, plan_id, holder }) => {
  const r = await broker.reservePath(mission_id, plan_id, holder ?? scenario.mission?.buyer_id ?? "buyer:emergency-ops");
  return { content: [{ type: "text", text: r.ok ? `Reserved ${plan_id}: ${r.grants.length} grants, $${r.total_usd.toFixed(2)} paid\n` + r.receipts.map((x) => `  ${x.operator_id} $${x.amount_usd.toFixed(2)} ${x.method ?? ""} ${x.receipt_ref ?? ""}`).join("\n") : `NOT reserved: ${r.reason}` }], structuredContent: r, ...(r.ok ? {} : {}) };
});

export const submitMission = server.tool({
  name: "submit_mission", title: "Submit mission",
  description: "Start (or resume after a disruption) execution of a reserved plan in the world simulator. Grants are presented to each operator at fulfilment time together with signed world assertions.",
  inputSchema: z.object({ mission_id: z.string(), plan_id: z.string(), resume: z.boolean().optional().describe("true when continuing after REPLAN_REQUIRED") }),
  outputSchema: z.object({ mission_id: z.string(), status: z.string(), plan_id: z.string() }), annotations: rw,
}, async ({ mission_id, plan_id, resume }) => {
  const ms = broker.state(mission_id); const plan = ms.plans[plan_id];
  if (!plan) return { isError: true, content: [{ type: "text", text: `unknown plan ${plan_id}` }] };
  const grants = broker.grantsForPlan(mission_id, plan_id);
  const missing = plan.legs.map((l, i) => (l.quote_id && !grants[String(i)] ? i : -1)).filter((i) => i >= 0);
  if (missing.length) return { isError: true, content: [{ type: "text", text: `plan ${plan_id} has unpaid legs ${missing.join(",")} — call reserve_path first` }] };
  const r = resume ? await simFetch(`/missions/${mission_id}/resume`, { method: "POST", json: { plan, grants, broker_url: env.PUBLIC_BROKER_URL } }) : await simFetch("/missions", { method: "POST", json: { mission: ms.mission, plan, grants, broker_url: env.PUBLIC_BROKER_URL } });
  emit({ type: "narration", act: "execute", text: `Broker: ${resume ? "resumed" : "submitted"} ${mission_id} with plan ${plan.label}` });
  const data = { mission_id, status: String(r.status ?? "RUNNING"), plan_id };
  return { content: [{ type: "text", text: `${mission_id} ${data.status} (${plan.label})` }], structuredContent: data };
});

export const getMissionStatus = server.tool({
  name: "get_mission_status", title: "Mission status",
  description: "Live status of a mission: legs with bytes moved, attestations, committed results, payments/receipts, result when delivered. Poll every few seconds. Renders a live MCP App card.",
  inputSchema: z.object({ mission_id: z.string() }),
  outputSchema: z.object({ mission_id: z.string(), status: z.string(), sim_t: z.number().optional(), deadline_sim_t: z.number().optional(), budget_usd: z.number().optional(), spent_usd: z.number(), current_leg: z.number().optional(), legs: z.array(Any), committed: Any.optional(), result: Any.optional(), audit: z.array(Any).optional(), payments: z.array(Payment), grants: z.array(Grant), plan_id: z.string().optional(), last_event: z.string().optional() }),
  view: { name: "mission-status", description: "Live OrbitalNet mission card: legs, payments, result", prefersBorder: false }, annotations: ro,
}, async ({ mission_id }) => {
  const ms = broker.state(mission_id);
  let sim: any = {}; try { sim = await simFetch(`/missions/${mission_id}`); } catch (e: any) { sim = { status: ms.chosen_plan_id ? "UNKNOWN" : "NOT_SUBMITTED", error: String(e?.message ?? e) }; }
  const st = await simFetch("/state").catch(() => ({}));
  const spent = ms.payments.reduce((a, p) => a + p.amount_usd, 0);
  const data = { mission_id, status: String(sim.status ?? "UNKNOWN"), sim_t: Number(sim.sim_t ?? st.sim_t ?? 0), deadline_sim_t: ms.mission.deadline_sim_t, budget_usd: ms.mission.budget_usd, spent_usd: spent, current_leg: sim.current_leg, legs: sim.legs ?? [], committed: sim.committed, result: sim.result, audit: sim.audit ?? [], payments: ms.payments.map(({ receipt, ...p }) => p), grants: ms.chosen_plan_id ? Object.values(broker.grantsForPlan(mission_id, ms.chosen_plan_id)) : [], plan_id: ms.chosen_plan_id, last_event: sim.audit?.length ? String(sim.audit[sim.audit.length - 1]?.text ?? JSON.stringify(sim.audit[sim.audit.length - 1])) : sim.error };
  return { content: [{ type: "text", text: `${mission_id}: ${data.status} @T+${data.sim_t}s (deadline T+${data.deadline_sim_t}s) spent $${spent.toFixed(2)}` + (data.committed ? ` committed result at ${data.committed.node_id}` : "") + (data.result ? ` RESULT: ${JSON.stringify(data.result.summary ?? {})}` : "") }], structuredContent: data };
});

export const injectDisruption = server.tool({
  name: "inject_disruption", title: "Inject disruption (judge)",
  description: "Judge/operator control: break the world and watch the protocol recover. kill_link (window_id), restore_link, competing_reserve (node_id, fraction), launch_provider (node_id — a brand-new operator boots and self-registers), revoke (node_id — operator revokes unfulfilled capacity; paid grants trigger refund vouchers).",
  inputSchema: z.object({ type: z.enum(["kill_link", "restore_link", "competing_reserve", "launch_provider", "revoke"]), window_id: z.string().optional(), node_id: z.string().optional(), fraction: z.number().min(0).max(1).optional(), label: z.string().optional() }),
  outputSchema: z.object({ ok: z.boolean(), event: Any }), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async (input) => {
  const r = await simFetch("/disrupt", { method: "POST", json: input });
  if (input.type === "launch_provider") setTimeout(() => registry.crawl().catch(() => {}), 2500);
  return { content: [{ type: "text", text: `disruption ${input.type}: ${JSON.stringify(r.event ?? r)}` }], structuredContent: { ok: Boolean(r.ok ?? true), event: r.event ?? r } };
});

const ReconcileRow = z.object({
  grant_id: z.string(), operator_id: z.string(), node_id: z.string(), capability: z.string(), window_id: z.string(), price_usd: z.number(),
  status: z.enum(["fulfilled", "refunded", "unfulfilled"]), receipt_ref: z.string().nullish(), attestation_id: z.string().nullish(),
  checks: z.record(z.string(), z.boolean().nullable()), details: z.array(z.string()),
}).passthrough();
export const reconcileMission = server.tool({
  name: "reconcile_mission", title: "Reconcile mission",
  description: "Audit the OCGP triple for a mission: for every paid grant, check the MPP receipt is present, the grant and the provider's usage attestation (or refund voucher) verify against the provider's manifest key, the attestation names the same grant/node/receipt, attested usage is within the grant's limits, and the price is within the quote. Any violation marks the provider untrusted in the registry. Call after DELIVERED (or any time) to prove what was paid == what was authorised == what was done.",
  inputSchema: z.object({ mission_id: z.string().describe("Mission to reconcile") }),
  outputSchema: z.object({ ok: z.boolean(), mission_id: z.string(), summary: z.string(), rows: z.array(ReconcileRow), violations: z.array(z.object({ grant_id: z.string(), operator_id: z.string(), check: z.string(), detail: z.string() })) }),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async ({ mission_id }) => {
  const r = await broker.reconcileMission(mission_id);
  const text = [`${r.ok ? "OK" : "VIOLATIONS"} — ${r.summary}`, ...r.rows.map((x) => `${x.grant_id} ${x.operator_id}/${x.node_id} ${x.capability} ${x.window_id} $${x.price_usd.toFixed(2)} [${x.status}] ${Object.entries(x.checks).map(([k, v]) => `${k}=${v === null ? "n/a" : v ? "✓" : "✗"}`).join(" ")}${x.details.length ? " — " + x.details.join("; ") : ""}`)].join("\n");
  return { content: [{ type: "text", text }], structuredContent: r };
});
server.get("/reconcile/:mission_id", async (c) => c.json(await broker.reconcileMission(c.req.param("mission_id"))));

export const resetWorld = server.tool({
  name: "reset_world", title: "Reset world",
  description: "Reload the scenario, set sim time to 0, and clear broker mission state (grants/payments records). Does not refund anything.",
  inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async () => { const r = await simFetch("/reset", { method: "POST", json: {} }); broker.missions.clear(); return { content: [{ type: "text", text: "world reset" }], structuredContent: { ok: Boolean(r.ok ?? true) } }; });

// ---------- boot ----------
registry.startCrawler(10_000);
getPayFetch().catch((e) => console.error("[pay] init failed", e));
console.log(`[marketplace] sim=${env.SIM_URL}${env.MOCK_SIM ? " (MOCK)" : ""} seeds=${env.REGISTRY_SEED.join(",")} rail=${env.PAY_RAIL}`);

export default server;
