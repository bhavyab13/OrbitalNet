/** Broker logic: quotes, planning, conditional commitment (hold → pay → grant), mission state. */
import { env, scenario } from "./config.js";
import * as registry from "./registry.js";
import { simFetch, emit } from "./sim.js";
import { paidPost } from "./pay.js";
import { verify, type Quote, type Plan, type Leg, type Grant } from "./protocol.js";

export type MissionState = {
  mission: any; plans: Record<string, Plan>; quotes: Record<string, Quote>;
  grants: Record<string, Grant>; // key: `${plan_id}:${leg_index}`
  payments: Array<{ operator_id: string; node_id: string; amount_usd: number; method?: string; receipt_ref?: string; receipt?: any; grant_id?: string; ts: string }>;
  chosen_plan_id?: string; history: string[];
};
export const missions = new Map<string, MissionState>();
export function state(mission_id: string): MissionState {
  let m = missions.get(mission_id);
  if (!m) { m = { mission: { ...(scenario.mission ?? {}), mission_id }, plans: {}, quotes: {}, grants: {}, payments: [], history: [] }; missions.set(mission_id, m); }
  return m;
}

async function postJson(url: string, json: any, ms = 10_000) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json), signal: AbortSignal.timeout(ms) });
  const text = await res.text(); let body: any; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

/** Which provider (if any) is paid for a leg. Compute leg → its node's operator. Transfer leg → the relay-capable endpoint. */
export function chargeTarget(leg: Leg): { entry: registry.Entry; capability: "compute" | "relay"; units: Record<string, number> } | undefined {
  if (leg.kind === "compute") {
    const e = registry.byNode(leg.node ?? leg.node_id ?? "");
    if (!e) return undefined;
    return { entry: e, capability: "compute", units: { compute_s: Math.max(1, Math.ceil(leg.duration_s ?? 1)), mb: leg.bytes_mb } };
  }
  // Pricing convention (sim planner + PROTOCOL): a relay operator charges on the DOWNLINK leg it performs
  // (relay node -> ground station). Crosslinks into a relay are free, and a leg the sim priced at 0 is never charged.
  const isDownlink = typeof leg.to === "string" && leg.to.startsWith("GS-");
  if (!isDownlink) return undefined;
  if (leg.price_usd !== undefined && leg.price_usd !== null && Number(leg.price_usd) === 0 && !leg.price_estimated) return undefined;
  const e = leg.operator_id ? registry.byOperator(leg.operator_id) : (leg.from ? registry.byNode(leg.from) : undefined);
  if (e && e.manifest.capabilities.some((c) => c.type === "relay")) return { entry: e, capability: "relay", units: { mb: leg.bytes_mb } };
  return undefined;
}

export async function requestQuote(mission_id: string, entry: registry.Entry, capability: string, window_id: string, units: Record<string, number>, now_sim_t: number): Promise<Quote | { error: string }> {
  const r = await postJson(`${entry.base_url}/quote`, { mission_id, capability, window_id, units, now_sim_t });
  if (!r.ok) return { error: `${entry.operator_id} ${window_id}: ${r.status} ${r.body?.reason ?? r.body?.error ?? ""}`.trim() };
  const q: Quote = r.body.quote ?? r.body;
  if (!(await verify(q, entry.manifest.public_key))) return { error: `${entry.operator_id} ${window_id}: quote signature invalid` };
  state(mission_id).quotes[q.quote_id] = q;
  return q;
}

export function explain(p: Plan, deadline: number, budget: number): string {
  const legs = p.legs.map((l) => l.kind === "compute" ? `run ${l.op ?? "inference"} on ${l.node ?? l.node_id} (${l.duration_s}s)` : `${l.from}→${l.to} ${Number(l.bytes_mb).toFixed(2)} MB in ${l.window_id}`).join("; then ");
  const head = p.feasible
    ? `FEASIBLE — delivers at T+${Math.round(p.delivery_sim_t ?? 0)}s (deadline T+${deadline}s), total $${p.cost_usd.toFixed(2)} of $${budget.toFixed(2)} budget.`
    : `NOT feasible — ${p.reasons.join("; ") || "no reason given"}.`;
  return `${head} Path: ${legs}.`;
}

/** Full planning pass: candidate legs → quotes from each provider → priced plans. */
export async function planMission(input: { mission_id: string; source_node?: string; payload_mb?: number; op?: string; model?: string; result_mb_estimate?: number; deadline_sim_t?: number; budget_usd?: number; now_sim_t?: number; preserve?: { node_id: string; result_mb: number }; exclude_windows?: string[]; }) {
  const ms = state(input.mission_id);
  const m = ms.mission;
  const spent = ms.payments.reduce((a, p) => a + p.amount_usd, 0);
  const now = input.now_sim_t ?? (await simFetch("/state").then((s: any) => s.sim_t).catch(() => 0));
  const req: any = {
    mission_id: input.mission_id, source_node: input.preserve?.node_id ?? input.source_node ?? m.source_node,
    payload_mb: input.preserve ? input.preserve.result_mb : (input.payload_mb ?? m.payload_mb),
    op: input.preserve ? undefined : (input.op ?? m.op), model: input.model ?? m.model,
    result_mb_estimate: input.result_mb_estimate ?? m.result_mb_estimate,
    deadline_sim_t: input.deadline_sim_t ?? m.deadline_sim_t, budget_usd: (input.budget_usd ?? m.budget_usd) - spent,
    now_sim_t: now, quotes: [], exclude_windows: input.exclude_windows ?? [], committed: input.preserve,
  };
  Object.assign(m, { source_node: req.source_node, deadline_sim_t: req.deadline_sim_t, budget_usd: input.budget_usd ?? m.budget_usd });
  emit({ type: "narration", act: "plan", text: `Broker: planning ${input.mission_id} from ${req.source_node} (${req.payload_mb} MB, deadline T+${req.deadline_sim_t}s, budget $${req.budget_usd.toFixed(2)})` });
  const draft = await simFetch("/plan", { method: "POST", json: req });
  // Collect every (provider, capability, window, units) a candidate plan needs; dedupe.
  const need = new Map<string, { entry: registry.Entry; capability: string; window_id: string; units: Record<string, number> }>();
  for (const p of draft.plans ?? []) for (const leg of p.legs ?? []) {
    const t = chargeTarget(leg); if (!t) continue;
    const k = `${t.entry.operator_id}|${t.capability}|${leg.window_id}`;
    if (!need.has(k)) need.set(k, { entry: t.entry, capability: t.capability, window_id: leg.window_id, units: t.units });
  }
  const quoteErrors: string[] = [];
  const quotes = (await Promise.all([...need.values()].map(async (n) => {
    const q = await requestQuote(input.mission_id, n.entry, n.capability, n.window_id, n.units, now).catch((e) => ({ error: String(e?.message ?? e) }));
    if ("error" in q) { quoteErrors.push(q.error); return undefined; }
    return q;
  }))).filter(Boolean) as Quote[];
  emit({ type: "narration", act: "plan", text: `Broker: ${quotes.length} signed quotes from ${new Set(quotes.map((q) => q.operator_id)).size} independent operators${quoteErrors.length ? ` (${quoteErrors.length} declined)` : ""}` });
  const priced = quotes.length ? await simFetch("/plan", { method: "POST", json: { ...req, quotes } }) : draft;
  const plans: Plan[] = (priced.plans ?? []).map((p: Plan) => {
    // Attach quote ids/prices for legs the sim did not annotate.
    for (const leg of p.legs) if (!leg.quote_id) { const t = chargeTarget(leg); const q = t && quotes.find((x) => x.operator_id === t.entry.operator_id && x.window_id === leg.window_id && x.capability === t.capability); if (q) { leg.quote_id = q.quote_id; leg.price_usd = q.price_usd; leg.operator_id = q.operator_id; leg.node_id = q.node_id; leg.capability = q.capability; } }
    return { ...p, explanation: explain(p, req.deadline_sim_t, req.budget_usd) };
  });
  for (const p of plans) ms.plans[p.plan_id] = p;
  const feasible = plans.filter((p) => p.feasible);
  emit({ type: "narration", act: "plan", text: `Broker: ${plans.length} candidate plans, ${feasible.length} feasible` + (feasible[0] ? ` — best: ${feasible[0].label} ($${feasible[0].cost_usd.toFixed(2)}, T+${Math.round(feasible[0].delivery_sim_t ?? 0)}s)` : "") });
  return { mission_id: input.mission_id, now_sim_t: now, deadline_sim_t: req.deadline_sim_t, budget_remaining_usd: req.budget_usd, plans, quotes, quote_errors: quoteErrors };
}

/** Conditional commitment across owners (OCGP §3): hold every leg → pay every leg → verify grants. */
export async function reservePath(mission_id: string, plan_id: string, holder: string) {
  const ms = state(mission_id); const plan = ms.plans[plan_id];
  if (!plan) return { ok: false, reason: `unknown plan_id ${plan_id} (call plan_mission first)`, grants: [], receipts: [], total_usd: 0 };
  if (!plan.feasible) return { ok: false, reason: `plan ${plan_id} is not feasible: ${plan.reasons.join("; ")}`, grants: [], receipts: [], total_usd: 0 };
  const legs = plan.legs.map((leg, i) => ({ leg, i })).filter(({ leg, i }) => leg.quote_id && !ms.grants[`${plan_id}:${i}`]);
  // Phase 1: holds
  const holds: Array<{ i: number; leg: Leg; entry: registry.Entry; hold_id?: string }> = [];
  for (const { leg, i } of legs) {
    const q = ms.quotes[leg.quote_id!]; const entry = q && registry.byOperator(q.operator_id);
    if (!q || !entry) return { ok: false, reason: `leg ${i}: quote ${leg.quote_id} unknown or provider offline`, grants: [], receipts: [], total_usd: 0 };
    const r = await postJson(`${entry.base_url}/hold`, { quote_id: q.quote_id, ttl_s: 60, mission_id }).catch((e) => ({ ok: false, status: 0, body: { reason: String(e?.message ?? e) } }));
    if (!r.ok) { emit({ type: "narration", act: "reserve", text: `Broker: hold refused by ${entry.operator_id} for ${leg.window_id} (${r.body?.reason ?? r.status}) — releasing, no money moved` }); return { ok: false, reason: `hold refused by ${entry.operator_id} for ${leg.window_id}: ${r.body?.reason ?? r.status}`, grants: [], receipts: [], total_usd: 0 }; }
    holds.push({ i, leg, entry, hold_id: r.body.hold_id });
  }
  emit({ type: "narration", act: "reserve", text: `Broker: all ${holds.length} legs held across ${new Set(holds.map((h) => h.entry.operator_id)).size} operators — path is feasible, committing payments` });
  // Phase 2: pay + grants
  const grants: Grant[] = []; const receipts: any[] = []; let total = 0;
  for (const h of holds) {
    const q = ms.quotes[h.leg.quote_id!];
    const r = await paidPost(`${h.entry.base_url}/reserve`, { quote_id: q.quote_id, hold_id: h.hold_id, mission_id, holder });
    if (r.status === 402) return { ok: false, reason: `payment required by ${h.entry.operator_id} but broker could not pay (rail=${env.PAY_RAIL})`, grants, receipts, total_usd: total };
    if (r.status >= 300) return { ok: false, reason: `reserve failed at ${h.entry.operator_id}: ${r.status} ${r.body?.reason ?? r.body?.error ?? ""}`, grants, receipts, total_usd: total };
    const grant: Grant = r.body.grant ?? r.body;
    const okSig = await verify(grant, h.entry.manifest.public_key);
    if (!okSig) return { ok: false, reason: `grant from ${h.entry.operator_id} failed signature verification`, grants, receipts, total_usd: total };
    const receipt = r.receipt ?? grant.payment?.receipt;
    const ref = r.receipt_ref ?? grant.payment?.receipt_ref ?? receipt?.reference;
    ms.grants[`${plan_id}:${h.i}`] = grant; grants.push(grant); total += Number(grant.price_usd ?? q.price_usd);
    const pay = { operator_id: h.entry.operator_id, node_id: h.entry.node_id, amount_usd: Number(grant.price_usd ?? q.price_usd), method: r.method ?? grant.payment?.method, receipt_ref: ref, receipt, grant_id: grant.grant_id, ts: new Date().toISOString() };
    ms.payments.push(pay); receipts.push({ ...pay, receipt: undefined });
    emit({ type: "payment", operator_id: pay.operator_id, node_id: pay.node_id, amount_usd: pay.amount_usd, method: pay.method, receipt_ref: ref, grant_id: grant.grant_id, mission_id });
    emit({ type: "grant_issued", grant_id: grant.grant_id, operator_id: pay.operator_id, node_id: pay.node_id, window_id: grant.window_id, capability: grant.capability, mission_id });
  }
  ms.chosen_plan_id = plan_id; ms.history.push(`reserved ${plan_id} $${total.toFixed(2)}`);
  emit({ type: "plan_chosen", mission_id, plan_id, label: plan.label, cost_usd: plan.cost_usd, delivery_sim_t: plan.delivery_sim_t });
  return { ok: true, reason: "", plan_id, grants, receipts, total_usd: total };
}

export function grantsForPlan(mission_id: string, plan_id: string): Record<string, Grant> {
  const ms = state(mission_id); const out: Record<string, Grant> = {};
  for (const [k, g] of Object.entries(ms.grants)) if (k.startsWith(plan_id + ":")) out[k.split(":")[1]] = g;
  return out;
}
