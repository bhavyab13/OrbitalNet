import { describe, it, expect, beforeAll } from "vitest";
import { signAs, loadKey, sign, generateKey, type Grant } from "@orbitalnet/protocol";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/index.ts";

process.env.PAY_RAIL = "mock";
process.env.SIM_URL = "http://127.0.0.1:1"; // unreachable → local clock fallback
process.env.BROKER_URL = "http://127.0.0.1:1";

function cfgFor(node: string, op: string, port: number) {
  process.env.NODE_ID = node;
  process.env.OPERATOR_ID = op;
  process.env.PORT = String(port);
  return loadConfig();
}
const wa = (window_id: string, sim_t: number, open = true) => signAs("world", { sim_t, window_id, open, bandwidth_mbps: 50, issued_at: new Date().toISOString() });
const json = (app: any, path: string, body: any, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("relay operator (EDRS-C)", () => {
  let app: any, st: any, cfg: any;
  beforeAll(async () => {
    cfg = cfgFor("EDRS-C", "lumen-relay", 7902);
    ({ app, st } = await buildApp(cfg));
  });

  it("serves a signed manifest", async () => {
    const m = await (await app.request("/.well-known/ocgp.json")).json();
    expect(m.ocgp).toBe("0.1");
    expect(m.node_id).toBe("EDRS-C");
    const { verify } = await import("@orbitalnet/protocol");
    expect(verify(m, loadKey("lumen-relay").public_key)).toBe(true);
  });

  it("prices quotes with the scarcity rule and floors at price_min", async () => {
    const q = await (await json(app, "/quote", { mission_id: "m", capability: "relay", window_id: "w_C_GS_1", units: { mb: 0.04 }, now_sim_t: 10 })).json();
    expect(q.price_usd).toBe(0.5); // 0.02*0.04 + 0.5*0.04/500 < min 0.50
    const big = await (await json(app, "/quote", { mission_id: "m", capability: "relay", window_id: "w_C_GS_1", units: { mb: 180 }, now_sim_t: 10 })).json();
    expect(big.price_usd).toBeCloseTo(0.02 * 180 + 0.5 * (180 / 500), 2);
    const tooBig = await json(app, "/quote", { mission_id: "m", capability: "relay", window_id: "w_C_GS_1", units: { mb: 900 }, now_sim_t: 10 });
    expect(tooBig.status).toBe(403);
    const wrongWin = await json(app, "/quote", { mission_id: "m", capability: "relay", window_id: "w_A_B_1", units: { mb: 1 }, now_sim_t: 10 });
    expect(wrongWin.status).toBe(403);
  });

  it("competing demand raises price", async () => {
    const before = (await (await json(app, "/quote", { mission_id: "m", capability: "relay", window_id: "w_C_GS_1", units: { mb: 100 }, now_sim_t: 10 })).json()).price_usd;
    const r = await json(app, "/admin/capacity", { fraction_taken: 0.6, label: "test" }, { "x-admin-token": cfg.ADMIN_TOKEN });
    expect(r.status).toBe(200);
    const after = (await (await json(app, "/quote", { mission_id: "m", capability: "relay", window_id: "w_C_GS_1", units: { mb: 100 }, now_sim_t: 10 })).json()).price_usd;
    expect(after).toBeGreaterThan(before);
    await json(app, "/admin/capacity", { fraction_taken: 0 }, { "x-admin-token": cfg.ADMIN_TOKEN });
    const unauth = await json(app, "/admin/capacity", { fraction_taken: 0.1 }, {});
    expect(unauth.status).toBe(401);
  });

  it("reserve (mock rail) returns a signed grant bound to a receipt; holds reduce capacity", async () => {
    const q = await (await json(app, "/quote", { mission_id: "fire-001", capability: "relay", window_id: "w_C_GS_1", units: { mb: 200 }, now_sim_t: 10 })).json();
    const h = await (await json(app, "/hold", { quote_id: q.quote_id, ttl_s: 60 })).json();
    expect(h.hold_id).toBeDefined();
    const cap = (await (await app.request("/status")).json()).capacity.mb;
    expect(cap).toBeLessThanOrEqual(300);
    const r = await json(app, "/reserve", { quote_id: q.quote_id, hold_id: h.hold_id, holder: "buyer:test" });
    expect(r.status).toBe(200);
    const { grant } = await r.json();
    expect(grant.payment.receipt.method).toBe("mock");
    expect(grant.payment.receipt_ref).toMatch(/^mock_/);
    const { verify } = await import("@orbitalnet/protocol");
    expect(verify(grant, loadKey("lumen-relay").public_key)).toBe(true);
    const unknown = await json(app, "/reserve", { quote_id: "nope" });
    expect(unknown.status).toBe(404);
  });

  async function freshGrant(mb = 0.04): Promise<Grant> {
    const q = await (await json(app, "/quote", { mission_id: "fire-001", capability: "relay", window_id: "w_C_GS_1", units: { mb }, now_sim_t: 10 })).json();
    return (await (await json(app, "/reserve", { quote_id: q.quote_id, holder: "buyer:test" })).json()).grant;
  }
  const payload = Buffer.alloc(3000).toString("base64");

  it("transmit succeeds inside the window with a valid world assertion, then rejects replay", async () => {
    const g = await freshGrant();
    const ok = await json(app, "/transmit", { grant: g, world_assertion: wa("w_C_GS_1", 320), payload_b64: payload });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.attestation.grant_id).toBe(g.grant_id);
    expect(body.attestation.input_bytes).toBe(3000);
    const again = await json(app, "/transmit", { grant: g, world_assertion: wa("w_C_GS_1", 321), payload_b64: payload });
    expect(again.status).toBe(403);
    expect((await again.json()).reason).toBe("already_used");
  });

  it("rejects: window closed / wrong window / expired / bad world sig / bad grant sig / too large / revoked", async () => {
    const g = await freshGrant();
    const reason = async (body: any) => (await (await json(app, "/transmit", body)).json()).reason;
    expect(await reason({ grant: g, world_assertion: wa("w_C_GS_1", 320, false), payload_b64: payload })).toBe("window_closed");
    expect(await reason({ grant: g, world_assertion: wa("w_A_B_1", 100), payload_b64: payload })).toBe("window_closed");
    expect(await reason({ grant: g, world_assertion: wa("w_C_GS_1", 290), payload_b64: payload })).toBe("window_closed");
    expect(await reason({ grant: g, world_assertion: wa("w_C_GS_1", 9999), payload_b64: payload })).toBe("expired");
    const fakeWorld = generateKey("world");
    const badWa = sign({ sim_t: 320, window_id: "w_C_GS_1", open: true, issued_at: "x" }, fakeWorld.private_key!, "world");
    expect(await reason({ grant: g, world_assertion: badWa, payload_b64: payload })).toBe("bad_world_assertion");
    expect(await reason({ grant: { ...g, price_usd: 0.01 }, world_assertion: wa("w_C_GS_1", 320), payload_b64: payload })).toBe("bad_signature");
    expect(await reason({ grant: g, world_assertion: wa("w_C_GS_1", 320), payload_b64: Buffer.alloc(60_000).toString("base64") })).toBe("payload_too_large");
    const rv = await json(app, "/admin/revoke", { grant_id: g.grant_id, reason: "test" }, { "x-admin-token": cfg.ADMIN_TOKEN });
    expect((await rv.json()).vouchers[0].amount_usd).toBe(g.price_usd);
    expect(await reason({ grant: g, world_assertion: wa("w_C_GS_1", 320), payload_b64: payload })).toBe("revoked");
    // refunding a fulfilled grant is denied
    const g2 = await freshGrant();
    await json(app, "/transmit", { grant: g2, world_assertion: wa("w_C_GS_1", 330), payload_b64: payload });
    expect((await json(app, "/refund", { grant_id: g2.grant_id, reason: "x" })).status).toBe(409);
  });
});

describe("compute operator (PHISAT-2)", () => {
  let app: any, cfg: any;
  beforeAll(async () => {
    cfg = cfgFor("PHISAT-2", "orbital-foundry", 7901);
    ({ app } = await buildApp(cfg));
  });
  it("quotes compute with base + per-second + scarcity", async () => {
    const q = await (await json(app, "/quote", { mission_id: "m", capability: "compute", window_id: "w_A_B_1", units: { compute_s: 45 }, now_sim_t: 10 })).json();
    expect(q.price_usd).toBeCloseTo(1.5 + 0.01 * 45 + 1.0 * (28 / 100), 2);
  });
  it("executes real inference under a valid grant and signs an attestation; deducts power", async () => {
    const q = await (await json(app, "/quote", { mission_id: "fire-001", capability: "compute", window_id: "w_A_B_1", units: { compute_s: 45 }, now_sim_t: 10 })).json();
    const { grant } = await (await json(app, "/reserve", { quote_id: q.quote_id, holder: "buyer:test", model: "fire-detector-v1" })).json();
    const img = (await import("node:fs")).readFileSync(`${cfg.ROOT}/${cfg.scenario.mission.scene.image_file}`);
    const r = await json(app, "/execute", { grant, world_assertion: wa("w_A_B_1", 100), payload_b64: img.toString("base64"), params: { payload_mb: 180 } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.result.summary.clusters).toBeGreaterThan(0);
    expect(body.result.geojson.type).toBe("FeatureCollection");
    expect(body.attestation.input_bytes).toBe(180e6);
    expect(body.attestation.power_wh).toBe(28);
    const { verify } = await import("@orbitalnet/protocol");
    expect(verify(body.attestation, loadKey("orbital-foundry").public_key)).toBe(true);
    const status = await (await app.request("/status")).json();
    expect(status.power_wh).toBe(72);
    // over-limit declared payload on a fresh grant is rejected before any compute
    const q2 = await (await json(app, "/quote", { mission_id: "fire-001", capability: "compute", window_id: "w_A_B_1", units: { compute_s: 45 }, now_sim_t: 10 })).json();
    const g2 = (await (await json(app, "/reserve", { quote_id: q2.quote_id, holder: "buyer:test" })).json()).grant;
    const big = await json(app, "/execute", { grant: g2, world_assertion: wa("w_A_B_1", 100), payload_b64: "AAAA", params: { payload_mb: 900 } });
    expect((await big.json()).reason).toBe("payload_too_large");
  });
});
