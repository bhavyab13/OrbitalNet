/**
 * Metered relay transfers (OCGP §2.10): the broker pays a relay per 100 KB as bytes flow over an
 * MPP session (TIP-1034 payment channel on Tempo). On the Stripe rail the relay settles the channel
 * to its Stripe balance. The broker wallet opens the channel, the SSE stream carries per-unit charges,
 * and `close()` settles the remainder on-chain.
 */
import { env } from "./config.js";
import * as registry from "./registry.js";
import { emit } from "./sim.js";
import { state } from "./broker.js";

export type StreamRequest = { mission_id: string; operator_id: string; grant: any; world_assertion: any; payload_b64: string; bytes_mb: number; base_url?: string };
export type StreamResult = { ok: boolean; reason?: string; attestation?: any; metered_usd?: number; units?: number; receipt_ref?: string; settlement_refs?: string[]; channel_id?: string };

type Progress = { unit?: number; units_total?: number; mb_moved?: number; mb_total?: number; usd_accrued?: number; done?: boolean; attestation?: any; metered_usd?: number };

async function* parseSse(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) yield data;
    }
  }
}

export async function streamTransfer(req: StreamRequest): Promise<StreamResult> {
  const base = req.base_url ?? registry.byOperator(req.operator_id)?.base_url;
  if (!base) return { ok: false, reason: `operator ${req.operator_id} not in registry` };
  const url = `${base.replace(/\/$/, "")}/transmit/stream`;
  const grant = req.grant; const wa = req.world_assertion;
  const body = JSON.stringify({ grant, world_assertion: wa, payload_b64: req.payload_b64, bytes_mb: req.bytes_mb, mission_id: req.mission_id });
  const ms = state(req.mission_id);
  const link = { window_id: grant?.window_id, from: wa?.link?.[0] ?? grant?.node_id, to: wa?.link?.[1] };
  const receipts: any[] = []; let last: Progress = {}; let attestation: any; let channelId: string | undefined; let closeReceipt: any;
  const progress = (p: Progress) => {
    last = p;
    emit({ type: "transfer_progress", mission_id: req.mission_id, window_id: link.window_id, from: link.from, to: link.to, bytes_moved_mb: Number((p.mb_moved ?? 0).toFixed(4)), bytes_total_mb: Number((p.mb_total ?? req.bytes_mb).toFixed(4)), pct: p.units_total ? Math.round((100 * (p.unit ?? 0)) / p.units_total) : 100, usd_accrued: p.usd_accrued ?? 0, metered: true });
  };
  try {
    let iter: AsyncIterable<string>;
    let manager: any;
    if (env.PAY_RAIL === "mock" || !env.MPPX_PRIVATE_KEY) {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body });
      if (!res.ok) { const t = await res.text(); let j: any; try { j = JSON.parse(t); } catch { j = { raw: t }; } return { ok: false, reason: j.reason ?? j.error ?? `http ${res.status}` }; }
      iter = parseSse(res);
    } else {
      const { sessionManager } = await import("mppx/client");
      const { privateKeyToAccount } = await import("viem/accounts");
      const account = privateKeyToAccount(env.MPPX_PRIVATE_KEY as `0x${string}`);
      const chains = process.env.TEMPO_MAINNET === "1" ? [4217] : [42431];
      manager = sessionManager({ account, allowedChainIds: chains, maxDeposit: process.env.SESSION_MAX_DEPOSIT ?? "2", fetch: globalThis.fetch.bind(globalThis) } as any);
      iter = await manager.sse(url, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body, onReceipt: (r: any) => { receipts.push(r); if (r?.channelId) channelId = r.channelId; } });
      if (!channelId && manager.channelId) channelId = manager.channelId;
    }
    let n = 0;
    for await (const data of iter) {
      let p: Progress; try { p = JSON.parse(data); } catch { continue; }
      n++;
      if (p.done) { attestation = p.attestation; last = p; progress(p); break; }
      if (n % 3 === 0 || p.unit === 1) progress(p);
    }
    if (manager) {
      if (!channelId && manager.channelId) channelId = manager.channelId;
      try { closeReceipt = await manager.close(); if (closeReceipt?.channelId) channelId = closeReceipt.channelId; } catch (e: any) { console.warn("[stream] close failed", e?.message ?? e); }
      console.log(`[stream] channel ${channelId ?? "?"} receipts=${receipts.length} close=${closeReceipt ? JSON.stringify({ txHash: closeReceipt.txHash, spent: closeReceipt.spent, units: closeReceipt.units }) : "none"}`);
    }
    // Settlement tx hashes live on the operator (it signs the on-chain settlements); read them back for the audit trail.
    try {
      const m: any = await fetch(`${base.replace(/\/$/, "")}/metered`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
      for (const st of m?.settlements ?? []) if (!channelId || st.channelId === channelId) receipts.push({ txHash: st.txHash, channelId: st.channelId, settled_usd: st.amount_usd });
    } catch {}
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // A 403 from the operator surfaces as a thrown fetch error inside the session manager; try to extract the reason.
    const m = msg.match(/"reason":"([^"]+)"/);
    return { ok: false, reason: m?.[1] ?? msg.slice(0, 200) };
  }
  if (!attestation) return { ok: false, reason: "stream ended without attestation" };
  const metered_usd = Number(last.metered_usd ?? last.usd_accrued ?? 0);
  const txs = [closeReceipt?.txHash, ...receipts.map((r) => r?.txHash)].filter(Boolean) as string[];
  const receipt_ref = closeReceipt?.txHash ?? txs[0] ?? channelId ?? "";
  const pay = { operator_id: req.operator_id, node_id: grant?.node_id, amount_usd: metered_usd, method: "mpp-session", receipt_ref, receipt: closeReceipt ?? receipts.at(-1), grant_id: grant?.grant_id, ts: new Date().toISOString(), units: last.units_total, channel_id: channelId };
  ms.payments.push(pay as any);
  emit({ type: "payment", mission_id: req.mission_id, operator_id: req.operator_id, node_id: grant?.node_id, amount_usd: metered_usd, method: "mpp-session", receipt_ref, grant_id: grant?.grant_id, description: `metered relay ${req.bytes_mb} MB over MPP session (${last.units_total ?? "?"} × 100 KB)`, settlement_refs: txs });
  return { ok: true, attestation, metered_usd, units: last.units_total, receipt_ref, settlement_refs: txs, channel_id: channelId };
}
