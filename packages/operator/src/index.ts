/**
 * OrbitalNet Operator Service — an independently administered satellite provider node.
 * Implements docs/API.md §2 and docs/PROTOCOL.md (OCGP v0.1).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sign, newId, sha256Hex, ManifestSchema, type Manifest } from "@orbitalnet/protocol";
import { loadConfig, type Config } from "./config.ts";
import { OperatorState } from "./state.ts";
import { verifyFulfilment } from "./verify.ts";
import { makePayments, type Payments } from "./pay.ts";
import { makeEmitter } from "./events.ts";
import { makeWorld } from "./world.ts";
import { runFireDetector } from "./inference.ts";

export async function buildApp(cfg: Config = loadConfig(), payments?: Payments) {
  let st = new OperatorState(cfg);
  const emit = makeEmitter(cfg);
  const world = makeWorld(cfg);
  const pay = payments ?? (await makePayments(cfg));
  const app = new Hono();
  app.use("*", cors());

  const reject = (c: any, reason: string, detail?: string, status = 403) => {
    emit("grant_rejected", { reason, detail });
    return c.json({ error: "ocgp/grant-rejected", reason, detail }, status);
  };
  const policy = () => ({
    allowed_ops: st.role === "compute" ? ["image-inference"] : ["relay"],
    deny_arbitrary_code: true,
    max_grant_ttl_s: 1800,
    refund_on_provider_outage: true,
  });

  function manifest(nowSimT: number): Manifest {
    const m = {
      ocgp: "0.1" as const,
      operator_id: cfg.OPERATOR_ID,
      operator_name: cfg.OPERATOR_NAME,
      node_id: cfg.NODE_ID,
      public_key: cfg.key.public_key,
      base_url: cfg.PUBLIC_URL,
      capabilities: [cfg.node.capability as any],
      policy: policy(),
      payment: { protocol: "mpp" as const, methods: pay.methods, currency: "USD", recipient: pay.recipient || undefined },
      capacity: st.capacity(nowSimT),
    };
    const signed = sign(m as any, cfg.key.private_key!, cfg.KID);
    return ManifestSchema.parse(signed);
  }

  app.get("/", (c) => c.json({ service: "orbitalnet-operator", node_id: cfg.NODE_ID, operator_id: cfg.OPERATOR_ID, manifest: "/.well-known/ocgp.json" }));
  app.get("/.well-known/ocgp.json", async (c) => c.json(manifest(await world.simT())));
  app.get("/keys", (c) => c.json({ kid: cfg.KID, public_key: cfg.key.public_key }));
  app.get("/status", async (c) => c.json(st.summary(await world.simT())));

  app.post("/quote", async (c) => {
    const body = await c.req.json();
    const now = Number(body.now_sim_t ?? (await world.simT()));
    const r = st.makeQuote(body, now);
    if ("error" in r) return c.json({ error: "ocgp/policy", reason: r.error }, 403);
    return c.json(r.quote);
  });

  app.post("/hold", async (c) => {
    const body = await c.req.json();
    if (st.failNextHold) {
      const label = st.failNextHold; st.failNextHold = null;
      await emit("hold_refused", { quote_id: body.quote_id, reason: "capacity_withdrawn", label });
      return c.json({ error: "ocgp/hold-failed", reason: `capacity withdrawn by operator (${label})` }, 409);
    }
    const r = st.makeHold(String(body.quote_id), Number(body.ttl_s ?? 60), await world.simT());
    if ("error" in r) return c.json({ error: "ocgp/hold-failed", reason: r.error }, 409);
    return c.json(r.hold);
  });

  app.post("/hold/release", async (c) => {
    const body = await c.req.json();
    st.holds.delete(String(body.hold_id));
    return c.json({ ok: true });
  });

  // MPP-gated: 402 challenge → client pays → Grant bound to the receipt.
  app.post("/reserve", async (c) => {
    const raw = c.req.raw;
    const text = await raw.clone().text();
    let body: any = {};
    try { body = JSON.parse(text || "{}"); } catch { return c.json({ error: "bad json" }, 400); }
    const q = st.quotes.get(String(body.quote_id));
    if (!q) return c.json({ error: "ocgp/unknown-quote", reason: "quote_id unknown or expired" }, 404);
    const now = await world.simT();
    if (q.expires_sim_t < now) return c.json({ error: "ocgp/quote-expired" }, 409);
    if (body.hold_id && !st.holds.has(body.hold_id)) return c.json({ error: "ocgp/hold-expired" }, 409);
    if (!body.hold_id) {
      const need = Number(q.units[st.unitKey()] ?? 0);
      if (need > st.availableUnits(now)) return c.json({ error: "ocgp/no-capacity" }, 409);
    }
    const amount = q.price_usd.toFixed(2);
    const r = await pay.charge(raw, amount, `OCGP ${q.capability} reservation ${q.window_id} on ${cfg.NODE_ID} (${q.mission_id})`);
    if (r.status === 402) return r.challenge;
    const grant = st.issueGrant({
      quote: q,
      hold_id: body.hold_id,
      holder: String(body.holder ?? "unknown"),
      receipt: r.receipt,
      method: r.method,
      nowSimT: now,
      op: st.role === "compute" ? "image-inference" : "relay",
      model: st.role === "compute" ? String(body.model ?? (st.cap.models ?? [])[0] ?? "") : undefined,
    });
    await emit("payment", { mission_id: q.mission_id, amount_usd: q.price_usd, method: r.method, receipt_ref: grant.payment.receipt_ref, recipient: pay.recipient, sim_t: now });
    await emit("grant_issued", { mission_id: q.mission_id, grant_id: grant.grant_id, window_id: grant.window_id, price_usd: grant.price_usd, holder: grant.holder, sim_t: now });
    const resp = Response.json({ grant, receipt: r.receipt });
    return r.attach(resp);
  });

  app.post("/execute", async (c) => {
    if (st.role !== "compute") return c.json({ error: "ocgp/not-a-compute-node" }, 404);
    const body = await c.req.json();
    const worldPub = await world.fetchWorldPub();
    // Resolve payload
    let bytes: Uint8Array;
    try {
      if (body.payload_b64) bytes = new Uint8Array(Buffer.from(String(body.payload_b64), "base64"));
      else if (body.payload_url) {
        const r = await fetch(String(body.payload_url), { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) throw new Error(`payload fetch ${r.status}`);
        bytes = new Uint8Array(await r.arrayBuffer());
      } else return c.json({ error: "payload_url or payload_b64 required" }, 400);
    } catch (e) {
      return c.json({ error: "payload_unavailable", detail: String(e) }, 400);
    }
    const declaredBytes = Number(body.params?.payload_mb ?? 0) * 1e6;
    const v = verifyFulfilment(st, worldPub, { grant: body.grant, world_assertion: body.world_assertion, payload_bytes: Math.max(bytes.byteLength, declaredBytes), op: body.params?.op });
    if (!v.ok) return reject(c, v.rej.reason, v.rej.detail);
    const { grant, wa } = v;
    const rec = st.grants.get(grant.grant_id)!;
    const bbox: number[] = body.params?.bbox ?? cfg.scenario.mission.scene.bbox;
    const truth = body.params?.truth_csv ?? join(cfg.ROOT, cfg.scenario.mission.scene.truth_csv);
    const t0 = Date.now();
    let result;
    try {
      result = await runFireDetector(cfg, bytes, bbox, { truth });
    } catch (e) {
      return c.json({ error: "inference_failed", detail: String(e) }, 500);
    }
    const computeS = (Date.now() - t0) / 1000;
    const modeled = Number(st.cap.modeled_compute_s ?? 0);
    const { thumbnail_b64, ...resultNoThumb } = result;
    const resultJson = JSON.stringify({ geojson: result.geojson, summary: result.summary, validation: result.validation });
    const outBytes = Buffer.byteLength(resultJson);
    const powerWh = Number(st.cap.job_power_wh ?? 0);
    st.powerWh = Math.max(0, st.powerWh - powerWh);
    const att = sign(
      {
        attestation_id: newId("a"),
        grant_id: grant.grant_id,
        mission_id: grant.mission_id,
        node_id: cfg.NODE_ID,
        operator_id: cfg.OPERATOR_ID,
        op: grant.op,
        input_bytes: Math.max(bytes.byteLength, declaredBytes),
        output_bytes: outBytes,
        compute_s: Number(computeS.toFixed(3)),
        power_wh: powerWh,
        result_sha256: sha256Hex(resultJson),
        sim_t_start: wa.sim_t,
        sim_t_end: wa.sim_t + (modeled || Math.ceil(computeS)),
        receipt_ref: grant.payment.receipt_ref,
      },
      cfg.key.private_key!,
      cfg.KID,
    );
    rec.status = "fulfilled";
    rec.attestation_id = att.attestation_id;
    st.ledger.push({ ts: new Date().toISOString(), sim_t: wa.sim_t, kind: "fulfilled", ref: grant.grant_id, note: `inference ${computeS.toFixed(2)}s, ${powerWh} Wh` });
    await emit("grant_fulfilled", { mission_id: grant.mission_id, grant_id: grant.grant_id, attestation_id: att.attestation_id, compute_s: computeS, power_wh_left: st.powerWh, output_bytes: outBytes, sim_t: wa.sim_t });
    return c.json({ result: { ...resultNoThumb, thumbnail_b64, result_bytes: outBytes }, attestation: att });
  });

  app.post("/transmit", async (c) => {
    if (st.role !== "relay") return c.json({ error: "ocgp/not-a-relay-node" }, 404);
    const body = await c.req.json();
    const worldPub = await world.fetchWorldPub();
    const payload = String(body.payload_b64 ?? "");
    const bytes = Buffer.from(payload, "base64").byteLength;
    const declaredBytes = Number(body.params?.payload_mb ?? 0) * 1e6;
    const v = verifyFulfilment(st, worldPub, { grant: body.grant, world_assertion: body.world_assertion, payload_bytes: Math.max(bytes, declaredBytes), op: "relay" });
    if (!v.ok) return reject(c, v.rej.reason, v.rej.detail);
    const { grant, wa } = v;
    const rec = st.grants.get(grant.grant_id)!;
    const mb = Math.max(bytes, declaredBytes) / 1e6;
    const durationS = wa.bandwidth_mbps ? (mb * 8) / wa.bandwidth_mbps : 0;
    const att = sign(
      {
        attestation_id: newId("a"),
        grant_id: grant.grant_id,
        mission_id: grant.mission_id,
        node_id: cfg.NODE_ID,
        operator_id: cfg.OPERATOR_ID,
        op: "relay",
        input_bytes: Math.max(bytes, declaredBytes),
        output_bytes: Math.max(bytes, declaredBytes),
        compute_s: 0,
        power_wh: 0,
        result_sha256: sha256Hex(payload),
        sim_t_start: wa.sim_t,
        sim_t_end: wa.sim_t + Math.ceil(durationS),
        receipt_ref: grant.payment.receipt_ref,
      },
      cfg.key.private_key!,
      cfg.KID,
    );
    rec.status = "fulfilled";
    rec.attestation_id = att.attestation_id;
    st.ledger.push({ ts: new Date().toISOString(), sim_t: wa.sim_t, kind: "fulfilled", ref: grant.grant_id, note: `relayed ${mb.toFixed(3)} MB` });
    await emit("grant_fulfilled", { mission_id: grant.mission_id, grant_id: grant.grant_id, attestation_id: att.attestation_id, bytes: Math.max(bytes, declaredBytes), sim_t: wa.sim_t });
    return c.json({ attestation: att, delivered_bytes: Math.max(bytes, declaredBytes) });
  });

  app.post("/refund", async (c) => {
    const body = await c.req.json();
    const now = await world.simT();
    const r = st.refund(String(body.grant_id), String(body.reason ?? "provider_outage"), now);
    if (r.error) return c.json({ error: "ocgp/refund-denied", reason: r.error }, 409);
    await emit("refund", { grant_id: body.grant_id, voucher_id: r.voucher!.voucher_id, amount_usd: r.voucher!.amount_usd, reason: r.voucher!.reason, sim_t: now });
    return c.json({ voucher: r.voucher });
  });

  const admin = async (c: any, next: any) => {
    if (c.req.header("x-admin-token") !== cfg.ADMIN_TOKEN) return c.json({ error: "unauthorized" }, 401);
    await next();
  };
  app.post("/admin/reset", admin, async (c) => {
    st = new OperatorState(cfg);
    emit("capacity_changed", { label: "reset" });
    return c.json({ ok: true, status: st.summary(await world.simT()) });
  });

  app.post("/admin/revoke", admin, async (c) => {
    const body = await c.req.json();
    const now = await world.simT();
    const ids = body.all_unfulfilled ? [...st.grants.values()].filter((g) => g.status === "active").map((g) => g.grant.grant_id) : [String(body.grant_id)];
    const vouchers = [];
    for (const id of ids) {
      const r = st.refund(id, String(body.reason ?? "operator_revoked_capacity"), now);
      if (r.voucher) vouchers.push(r.voucher);
    }
    await emit("capacity_revoked", { grant_ids: ids, vouchers: vouchers.map((v) => v.voucher_id), sim_t: now });
    return c.json({ revoked: ids, vouchers });
  });
  app.post("/admin/capacity", admin, async (c) => {
    const body = await c.req.json();
    const now = await world.simT();
    st.competing = body.fraction_taken ? { fraction: Number(body.fraction_taken), label: String(body.label ?? "competing demand") } : null;
    if (body.fail_next_hold) st.failNextHold = String(body.label ?? "withdrawn at commit");
    await emit("capacity_changed", { competing: st.competing, capacity: st.capacity(now), sim_t: now });
    return c.json({ ok: true, capacity: st.capacity(now), competing: st.competing });
  });
  app.post("/admin/power", admin, async (c) => {
    const body = await c.req.json();
    st.powerWh = Number(body.power_wh);
    return c.json({ ok: true, power_wh: st.powerWh });
  });

  // Scene file convenience for local dev (the World normally hosts payloads)
  app.get("/scene", (c) => {
    const p = join(cfg.ROOT, cfg.scenario.mission.scene.image_file);
    if (!existsSync(p)) return c.text("no scene", 404);
    return new Response(readFileSync(p), { headers: { "content-type": "image/jpeg" } });
  });

  async function boot() {
    await world.fetchWorldPub();
    emit("provider_online", { operator_name: cfg.OPERATOR_NAME, base_url: cfg.PUBLIC_URL, role: st.role, capacity: st.capacity(await world.simT()) });
    const manifest_url = `${cfg.PUBLIC_URL}/.well-known/ocgp.json`;
    let tries = 0;
    const reg = async () => {
      tries++;
      try {
        const r = await fetch(`${cfg.BROKER_URL}/registry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest_url }), signal: AbortSignal.timeout(3000) });
        if (r.ok) { console.log(`[${cfg.NODE_ID}] registered with broker ${cfg.BROKER_URL}`); return; }
        throw new Error(String(r.status));
      } catch (e) {
        if (tries < 120) setTimeout(reg, 5000);
      }
    };
    reg();
    // keep trying to learn the world key if the sim was not up yet
    const keyPoll = setInterval(async () => { if (await world.fetchWorldPub()) clearInterval(keyPoll); }, 5000);
  }
  return { app, st, cfg, boot, world, pay };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isMain) {
  const cfg = loadConfig();
  const { app, boot } = await buildApp(cfg);
  serve({ fetch: app.fetch, port: cfg.PORT }, () => {
    console.log(`[${cfg.NODE_ID}] ${cfg.OPERATOR_NAME} (${cfg.node.capability?.type}) listening on ${cfg.PUBLIC_URL} rail=${cfg.PAY_RAIL}`);
    boot();
  });
}
