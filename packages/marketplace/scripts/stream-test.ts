/**
 * Metered relay (OCGP §2.10) end-to-end against a local relay operator:
 *   quote → hold → paid /reserve (MPP charge) → grant → metered /transmit/stream over an MPP session → attestation → settlements.
 * Usage: OP_URL=http://localhost:7012 MB=2 npx tsx scripts/stream-test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../src/config.js";
import { paidPost } from "../src/pay.js";
import { sign } from "../src/protocol.js";
import { streamTransfer } from "../src/stream.js";

const OP = process.env.OP_URL ?? "http://localhost:7012";
const MB = Number(process.env.MB ?? "2");
const WINDOW = process.env.WINDOW_ID ?? "w_C_GS_1";
const mission_id = process.env.MISSION_ID ?? `stream-test-${Date.now().toString(36)}`;
const j = (r: Response) => r.json() as Promise<any>;

const world = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "keys/world.json"), "utf8"));
const manifest = await fetch(`${OP}/.well-known/ocgp.json`).then(j);
console.log(`operator ${manifest.operator_id} @ ${manifest.base_url}; metered:`, await fetch(`${OP}/metered`).then(j));

const quote = await fetch(`${OP}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mission_id, capability: "relay", window_id: WINDOW, units: { mb: MB } }) }).then(j);
console.log("quote", quote.quote_id, "$" + quote.price_usd, "window", quote.window);
const hold = await fetch(`${OP}/hold`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quote_id: quote.quote_id, ttl_s: 120, mission_id }) }).then(j);
console.log("hold", hold.hold_id);
const res = await paidPost(`${OP}/reserve`, { quote_id: quote.quote_id, hold_id: hold.hold_id, mission_id, holder: "buyer:stream-test" });
if (res.status !== 200) { console.error("reserve failed", res.status, res.body); process.exit(1); }
const grant = res.body.grant;
console.log("grant", grant.grant_id, "reservation paid", res.method, res.receipt_ref, "limits", grant.limits);

// World assertion: the window is open and sim time sits inside the grant's window (signed by the world key, which the sim holds).
const wa = await sign({ sim_t: Number(grant.window.start) + 5, window_id: grant.window_id, open: true, link: [grant.node_id, "GS-PUNTA-ARENAS"], bandwidth_mbps: Number(grant.window.bandwidth_mbps ?? 50), window: { start: grant.window.start, end: grant.window.end }, issued_at: new Date().toISOString() }, world.private_key, "world");
const payload_b64 = Buffer.from(JSON.stringify({ kind: "test", note: "metered relay test payload" })).toString("base64");

const t0 = Date.now();
const out = await streamTransfer({ mission_id, operator_id: manifest.operator_id, grant, world_assertion: wa, payload_b64, bytes_mb: MB, base_url: OP });
console.log(`stream result in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify({ ...out, attestation: out.attestation ? { attestation_id: out.attestation.attestation_id, output_bytes: out.attestation.output_bytes, metered: out.attestation.metered, kid: out.attestation.kid } : undefined }, null, 1));
console.log("operator settlements:", JSON.stringify((await fetch(`${OP}/metered`).then(j)).settlements, null, 1));
process.exit(out.ok ? 0 : 2);
