import { newId, sign, type Quote, type Grant, type Hold, type RefundVoucher } from "@orbitalnet/protocol";
import type { Config } from "./config.ts";

export type GrantRecord = { grant: Grant; status: "active" | "fulfilled" | "revoked"; attestation_id?: string; refund?: RefundVoucher };
export type LedgerEntry = { ts: string; sim_t: number; kind: string; amount_usd?: number; ref?: string; note?: string };

const EPS = 1e-6;

export class OperatorState {
  quotes = new Map<string, Quote>();
  holds = new Map<string, Hold & { units: Quote["units"]; capability: string }>();
  grants = new Map<string, GrantRecord>();
  ledger: LedgerEntry[] = [];
  competing: { fraction: number; label: string } | null = null;
  /** E1 demo/test fixture: the provider withdraws between quote and hold (one-shot). */
  failNextHold: string | null = null;
  /** Reconciliation demo fixture: the NEXT attestation over-reports usage (still correctly signed). One-shot. */
  misbehave: "none" | "over_attest" = "none";
  powerWh: number;
  readonly cap: Record<string, any>;
  readonly role: "compute" | "relay";

  constructor(public cfg: Config) {
    this.cap = cfg.node.capability ?? {};
    this.role = this.cap.type === "compute" ? "compute" : "relay";
    this.powerWh = Number(this.cap.power_budget_wh ?? 0);
  }

  // ---- capacity accounting ----
  /** Total sellable units: relay → MB, compute → compute_s. */
  totalUnits(): number {
    return this.role === "relay" ? Number(this.cap.max_payload_mb) : Number(this.cap.max_compute_s);
  }
  unitKey(): "mb" | "compute_s" {
    return this.role === "relay" ? "mb" : "compute_s";
  }
  committedUnits(nowSimT: number): number {
    let u = 0;
    for (const h of this.holds.values()) if (h.expires_sim_t >= nowSimT) u += Number(h.units[this.unitKey()] ?? 0);
    for (const g of this.grants.values())
      if (g.status === "active") u += Number((g.grant as any).units?.[this.unitKey()] ?? this.unitsOfGrant(g.grant));
    return u;
  }
  unitsOfGrant(g: Grant): number {
    return this.role === "relay" ? Number(g.limits.max_payload_mb ?? 0) : Number(g.limits.max_compute_s ?? 0);
  }
  availableUnits(nowSimT: number): number {
    const total = this.totalUnits();
    const taken = this.competing ? total * this.competing.fraction : 0;
    return Math.max(0, total - taken - this.committedUnits(nowSimT));
  }
  capacity(nowSimT: number): Record<string, number> {
    const out: Record<string, number> = { [this.unitKey()]: Number(this.availableUnits(nowSimT).toFixed(3)) };
    if (this.role === "compute") out.power_wh = Number(this.powerWh.toFixed(2));
    return out;
  }

  // ---- pricing: p = p0 + α·d/max(c,ε) (+ per-unit) ----
  price(units: Quote["units"], nowSimT: number): { price: number; reason?: string } {
    const avail = this.availableUnits(nowSimT);
    const alpha = Number(this.cap.scarcity_alpha ?? 0);
    if (this.role === "relay") {
      const mb = Number(units.mb ?? 0);
      if (mb <= 0) return { price: 0, reason: "units.mb required" };
      if (mb > Number(this.cap.max_payload_mb)) return { price: 0, reason: `payload ${mb} MB exceeds max_payload_mb ${this.cap.max_payload_mb}` };
      if (mb > avail) return { price: 0, reason: `insufficient capacity: ${avail.toFixed(1)} MB available` };
      const p = Number(this.cap.price_per_mb) * mb + alpha * (mb / Math.max(avail, EPS));
      return { price: round2(Math.max(Number(this.cap.price_min_usd ?? 0), p)) };
    }
    const s = Number(units.compute_s ?? this.cap.modeled_compute_s ?? 0);
    if (s <= 0) return { price: 0, reason: "units.compute_s required" };
    if (s > Number(this.cap.max_compute_s)) return { price: 0, reason: `compute_s ${s} exceeds max_compute_s ${this.cap.max_compute_s}` };
    if (s > avail) return { price: 0, reason: `insufficient accelerator capacity: ${avail.toFixed(0)} s available` };
    const jobWh = Number(this.cap.job_power_wh ?? 0);
    if (jobWh > this.powerWh) return { price: 0, reason: `power budget exhausted (${this.powerWh.toFixed(1)} Wh left, job needs ${jobWh} Wh)` };
    const p =
      Number(this.cap.price_base_usd) + Number(this.cap.price_per_compute_s) * s + alpha * (jobWh / Math.max(this.powerWh, EPS));
    return { price: round2(p) };
  }

  makeQuote(body: { mission_id: string; capability: string; window_id: string; units: Quote["units"]; now_sim_t?: number }, nowSimT: number) {
    const w = this.cfg.scenario.windows.find((x) => x.window_id === body.window_id);
    if (!w) return { error: `unknown window ${body.window_id}` };
    if (w.from !== this.cfg.NODE_ID && w.to !== this.cfg.NODE_ID) return { error: `window ${body.window_id} does not involve ${this.cfg.NODE_ID}` };
    if (body.capability !== this.role) return { error: `this node sells ${this.role}, not ${body.capability}` };
    const units = this.role === "compute" ? { compute_s: Number(body.units?.compute_s ?? this.cap.modeled_compute_s) } : { mb: Number(body.units?.mb) };
    const pr = this.price(units, nowSimT);
    if (pr.reason) return { error: pr.reason };
    const q: Omit<Quote, "kid" | "sig"> = {
      quote_id: newId("q"),
      mission_id: body.mission_id,
      operator_id: this.cfg.OPERATOR_ID,
      node_id: this.cfg.NODE_ID,
      capability: this.role,
      window_id: w.window_id,
      window: { start: w.start, end: w.end, bandwidth_mbps: w.bandwidth_mbps },
      units,
      price_usd: pr.price,
      available_capacity: this.capacity(nowSimT),
      expires_sim_t: nowSimT + 300,
    };
    const signed = sign(q as any, this.cfg.key.private_key!, this.cfg.KID) as Quote;
    this.quotes.set(signed.quote_id, signed);
    return { quote: signed };
  }

  makeHold(quote_id: string, ttl_s: number, nowSimT: number) {
    const q = this.quotes.get(quote_id);
    if (!q) return { error: "unknown quote" };
    if (q.expires_sim_t < nowSimT) return { error: "quote expired" };
    const need = Number(q.units[this.unitKey()] ?? 0);
    if (need > this.availableUnits(nowSimT)) return { error: "insufficient capacity" };
    const h = { hold_id: newId("h"), quote_id, expires_sim_t: nowSimT + (ttl_s || 60), units: q.units, capability: q.capability };
    this.holds.set(h.hold_id, h);
    return { hold: { hold_id: h.hold_id, quote_id, expires_sim_t: h.expires_sim_t } };
  }

  issueGrant(args: { quote: Quote; hold_id?: string; holder: string; receipt: any; method: string; nowSimT: number; op: string; model?: string }) {
    const { quote: q } = args;
    if (args.hold_id) this.holds.delete(args.hold_id);
    const ttl = Number(this.cfg.node.capability?.max_grant_ttl_s ?? 1800);
    const limits =
      this.role === "compute"
        ? { max_input_mb: Number(this.cap.max_input_mb), max_compute_s: Number(q.units.compute_s ?? this.cap.max_compute_s), max_output_mb: 1 }
        : { max_payload_mb: Number(q.units.mb), max_output_mb: Number(q.units.mb) };
    const ref = String(args.receipt?.reference ?? args.receipt?.externalId ?? "");
    const g: Omit<Grant, "kid" | "sig"> = {
      grant_id: newId("g"),
      mission_id: q.mission_id,
      operator_id: this.cfg.OPERATOR_ID,
      node_id: this.cfg.NODE_ID,
      capability: this.role,
      op: args.op,
      model: args.model,
      window_id: q.window_id,
      window: q.window,
      limits,
      valid_sim_t: { not_before: Math.min(args.nowSimT, q.window.start), not_after: Math.min(q.window.end + 60, args.nowSimT + ttl) },
      price_usd: q.price_usd,
      payment: { protocol: "mpp", method: args.method, receipt_ref: ref, receipt: args.receipt },
      holder: args.holder,
      quote_id: q.quote_id,
      issued_at: new Date().toISOString(),
    };
    const signed = sign(g as any, this.cfg.key.private_key!, this.cfg.KID) as Grant;
    this.grants.set(signed.grant_id, { grant: signed, status: "active" });
    this.ledger.push({ ts: g.issued_at, sim_t: args.nowSimT, kind: "payment_received", amount_usd: q.price_usd, ref, note: `grant ${signed.grant_id}` });
    return signed;
  }

  refund(grant_id: string, reason: string, nowSimT: number): { voucher?: RefundVoucher; error?: string } {
    const rec = this.grants.get(grant_id);
    if (!rec) return { error: "unknown grant" };
    if (rec.status === "fulfilled") return { error: "grant already fulfilled — nothing to refund" };
    if (rec.refund) return { voucher: rec.refund };
    const v = sign(
      {
        voucher_id: newId("rv"),
        grant_id,
        mission_id: rec.grant.mission_id,
        operator_id: this.cfg.OPERATOR_ID,
        amount_usd: rec.grant.price_usd,
        reason,
        receipt_ref: rec.grant.payment.receipt_ref,
        issued_at: new Date().toISOString(),
      },
      this.cfg.key.private_key!,
      this.cfg.KID,
    ) as RefundVoucher;
    rec.refund = v;
    rec.status = "revoked";
    this.ledger.push({ ts: v.issued_at, sim_t: nowSimT, kind: "refund_voucher", amount_usd: -v.amount_usd, ref: v.voucher_id, note: reason });
    return { voucher: v };
  }

  summary(nowSimT: number) {
    let active = 0, fulfilled = 0, revoked = 0;
    for (const g of this.grants.values()) {
      if (g.status === "active") active++;
      else if (g.status === "fulfilled") fulfilled++;
      else revoked++;
    }
    return {
      node_id: this.cfg.NODE_ID,
      operator_id: this.cfg.OPERATOR_ID,
      role: this.role,
      sim_t: nowSimT,
      capacity: this.capacity(nowSimT),
      total_units: { [this.unitKey()]: this.totalUnits() },
      power_wh: this.role === "compute" ? this.powerWh : undefined,
      competing: this.competing,
      grants: { active, fulfilled, revoked, list: [...this.grants.values()].map((g) => ({ grant_id: g.grant.grant_id, mission_id: g.grant.mission_id, window_id: g.grant.window_id, status: g.status, price_usd: g.grant.price_usd, receipt_ref: g.grant.payment.receipt_ref })) },
      holds: [...this.holds.values()].filter((h) => h.expires_sim_t >= nowSimT).length,
      ledger: this.ledger.slice(-50),
    };
  }
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}
