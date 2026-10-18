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
export async function planMission(input: { mission_id: string; source_node?: string; payload_mb?: number; op?: string; model?: string; result_mb_estimate?: number; deadline_sim_t?: number; budget_usd?: number; now_sim_t?: number; preserve?: { node_id: string; result_mb: number }; exclude_windows?: string[]; required_fidelity?: string; text?: string; }) {
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
    required_fidelity: input.required_fidelity ?? m.required_fidelity ?? "any", degraded: m.degraded, text: input.text ?? m.text,
  };
  Object.assign(m, { source_node: req.source_node, deadline_sim_t: req.deadline_sim_t, budget_usd: input.budget_usd ?? m.budget_usd, required_fidelity: req.required_fidelity, text: req.text });
  emit({ type: "narration", act: "plan", text: `Broker: planning ${input.mission_id} from ${req.source_node} (${req.payload_mb} MB, deadline T+${req.deadline_sim_t}s, budget $${req.budget_usd.toFixed(2)})` });
  const draft = await simFetch("/plan", { method: "POST", json: req });
  // Collect every (provider, capability, window, units) a candidate plan needs; dedupe.
  const need = new Map<string, { entry: registry.Entry; capability: string; window_id: string; units: Record<string, number> }>();
  for (const p of draft.plans ?? []) for (const leg of p.legs ?? []) {
    const t = chargeTarget(leg); if (!t) continue;
    const k = `${t.entry.operator_id}|${t.capability}|${leg.window_id}|${JSON.stringify(t.units)}`; // units matter: a 40 MB crop and a 180 MB raw relay get separate quotes
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


// ---------------- Reconciliation (PROTOCOL §2.9): receipt ↔ grant ↔ attestation ----------------
export type ReconcileRow = {
  grant_id: string; operator_id: string; node_id: string; capability: string; window_id: string; price_usd: number;
  status: "fulfilled" | "refunded" | "unfulfilled"; receipt_ref?: string | null; attestation_id?: string | null;
  checks: Record<string, boolean | null>; details: string[];
};
export type ReconcileResult = { ok: boolean; mission_id: string; summary: string; rows: ReconcileRow[]; violations: Array<{ grant_id: string; operator_id: string; check: string; detail: string }> };

function walkAttestations(obj: any, out: any[], seen = new Set<any>()) {
  if (!obj || typeof obj !== "object" || seen.has(obj)) return; seen.add(obj);
  if (Array.isArray(obj)) { for (const x of obj) walkAttestations(x, out, seen); return; }
  if (typeof obj.attestation_id === "string" && typeof obj.grant_id === "string" && typeof obj.sig === "string") { out.push(obj); return; }
  for (const k of Object.keys(obj)) walkAttestations(obj[k], out, seen);
}

export async function reconcileMission(mission_id: string): Promise<ReconcileResult> {
  const ms = state(mission_id);
  const sim = await simFetch(`/missions/${mission_id}`).catch(() => null);
  const attestations: any[] = []; walkAttestations(sim ? { legs: sim.legs, previous_plans: sim.previous_plans, result: null } : null, attestations);
  const audit: any[] = sim?.audit ?? [];
  const vouchers: any[] = audit.filter((a) => a.type === "refund" && a.voucher?.voucher?.sig).map((a) => a.voucher.voucher);
  const rows: ReconcileRow[] = []; const violations: ReconcileResult["violations"] = [];
  const grants = Object.values(ms.grants);
  for (const g of grants as any[]) {
    const entry = registry.byOperator(g.operator_id); const key = entry?.manifest.public_key;
    const quote = ms.quotes[g.quote_id] ?? Object.values(ms.quotes).find((q: any) => q.window_id === g.window_id && q.operator_id === g.operator_id);
    const att = attestations.find((a) => a.grant_id === g.grant_id);
    const voucher = vouchers.find((v) => v.grant_id === g.grant_id);
    const status: ReconcileRow["status"] = att ? "fulfilled" : voucher ? "refunded" : "unfulfilled";
    const checks: Record<string, boolean | null> = {}; const details: string[] = [];
    const fail = (check: string, detail: string) => { checks[check] = false; details.push(detail); violations.push({ grant_id: g.grant_id, operator_id: g.operator_id, check, detail }); };
    checks.receipt_present = Boolean(g.payment?.receipt && g.payment?.receipt_ref); if (!checks.receipt_present) fail("receipt_present", "grant carries no payment receipt");
    checks.grant_sig_valid = key ? await verify(g, key) : null; if (checks.grant_sig_valid === false) fail("grant_sig_valid", "grant signature does not verify against the provider manifest key");
    checks.price_within_quote = quote ? Number(g.price_usd) <= Number((quote as any).price_usd) + 0.005 : null;
    if (checks.price_within_quote === false) fail("price_within_quote", `grant price $${g.price_usd} exceeds quote $${(quote as any).price_usd}`);
    if (status === "fulfilled") {
      checks.attestation_present = true;
      checks.attestation_sig_valid = key ? await verify(att, key) : null; if (checks.attestation_sig_valid === false) fail("attestation_sig_valid", "attestation signature does not verify");
      checks.attestation_matches_grant = att.grant_id === g.grant_id && att.node_id === g.node_id && (!att.receipt_ref || att.receipt_ref === g.payment?.receipt_ref);
      if (!checks.attestation_matches_grant) fail("attestation_matches_grant", `attestation names ${att.node_id}/${att.grant_id}/${att.receipt_ref}, grant is ${g.node_id}/${g.grant_id}/${g.payment?.receipt_ref}`);
      const lim = g.limits ?? {}; let within = true;
      const over = (what: string, used: number, allowed: number, unit: string) => { within = false; fail("usage_within_limits", `${g.operator_id} attested ${what} ${used}${unit} but the grant allowed ${allowed}${unit}`); };
      if (lim.max_compute_s !== undefined && Number(att.compute_s) > Number(lim.max_compute_s)) over("compute", Number(att.compute_s), Number(lim.max_compute_s), " s");
      if (lim.max_input_mb !== undefined && Number(att.input_bytes) > Number(lim.max_input_mb) * 1e6 * 1.1 + 8192) over("input", Math.round(Number(att.input_bytes) / 1e6), Number(lim.max_input_mb), " MB");
      if (lim.max_payload_mb !== undefined && Number(att.input_bytes) > Number(lim.max_payload_mb) * 1e6 * 1.1 + 8192) over("payload", Number((Number(att.input_bytes) / 1e6).toFixed(3)), Number(lim.max_payload_mb), " MB");
      if (lim.max_output_mb !== undefined && Number(att.output_bytes) > Number(lim.max_output_mb) * 1e6 * 1.1 + 8192) over("output", Number((Number(att.output_bytes) / 1e6).toFixed(3)), Number(lim.max_output_mb), " MB");
      checks.usage_within_limits = within;
    } else if (status === "refunded") {
      checks.refund_voucher_valid = key ? (await verify(voucher, key)) && Math.abs(Number(voucher.amount_usd) - Number(g.price_usd)) < 0.005 : null;
      if (checks.refund_voucher_valid === false) fail("refund_voucher_valid", `refund voucher invalid or amount $${voucher.amount_usd} != grant $${g.price_usd}`);
    } else {
      checks.attestation_present = null; // not yet fulfilled: nothing to reconcile
    }
    rows.push({ grant_id: g.grant_id, operator_id: g.operator_id, node_id: g.node_id, capability: g.capability, window_id: g.window_id, price_usd: Number(g.price_usd), status, receipt_ref: g.payment?.receipt_ref ?? null, attestation_id: att?.attestation_id ?? null, checks, details });
  }
  const nF = rows.filter((r) => r.status === "fulfilled").length, nR = rows.filter((r) => r.status === "refunded").length;
  const summary = `${rows.length} grants, ${nF} fulfilled, ${nR} refunded, ${violations.length} violations`;
  const ok = violations.length === 0;
  for (const v of violations) {
    const e = registry.byOperator(v.operator_id);
    registry.markUntrusted(v.operator_id, `${v.check}: ${v.detail}`);
    emit({ type: "reconcile_violation", mission_id, operator_id: v.operator_id, node_id: e?.node_id, grant_id: v.grant_id, check: v.check, detail: v.detail });
    emit({ type: "narration", act: "reconcile", text: `Reconciliation: ${e?.manifest.operator_name ?? v.operator_id} — ${v.detail} — flagged, provider marked untrusted` });
  }
  if (ok && rows.length) emit({ type: "narration", act: "reconcile", text: `Reconciliation: every receipt matches a grant matches an attestation (${nF + nR}/${rows.length})` });
  emit({ type: "reconcile_result", mission_id, ok, summary, rows: rows.map((r) => ({ grant_id: r.grant_id, operator_id: r.operator_id, status: r.status, ok: r.details.length === 0 })) });
  return { ok, mission_id, summary, rows, violations };
}
