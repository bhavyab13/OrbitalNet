"""Mission runner: executes a chosen plan against the world and the independent operator services."""
from __future__ import annotations

import asyncio
import base64
import io
import json
import time

import httpx

from . import config
from .world import World


def make_degraded_crop(image_path: str, scale: int = 8, quality: int = 70) -> tuple[str, int]:
    """Real deliverable for a low-fidelity plan: the scene downsampled 1/scale as JPEG. Returns (b64, bytes)."""
    from PIL import Image  # pillow
    with Image.open(image_path) as im:
        im = im.convert("RGB")
        small = im.resize((max(1, im.width // scale), max(1, im.height // scale)), Image.LANCZOS)
    buf = io.BytesIO()
    small.save(buf, format="JPEG", quality=quality)
    raw = buf.getvalue()
    return base64.b64encode(raw).decode(), len(raw)


class Runner:
    def __init__(self, world: World):
        self.w = world
        self.tasks: dict[str, asyncio.Task] = {}
        self.stops: dict[str, asyncio.Event] = {}

    def start(self, mission_id: str, resume: bool = False):
        self.stop(mission_id)
        stop = asyncio.Event()
        self.stops[mission_id] = stop
        self.tasks[mission_id] = asyncio.create_task(self._run(mission_id, stop, resume))

    def stop(self, mission_id: str):
        if mission_id in self.stops:
            self.stops[mission_id].set()
        t = self.tasks.pop(mission_id, None)
        if t and not t.done():
            t.cancel()

    def stop_all(self):
        for m in list(self.tasks):
            self.stop(m)

    def _url(self, operator_id: str | None, grant: dict | None) -> str | None:
        if grant and grant.get("base_url"):
            return grant["base_url"].rstrip("/")
        return config.operator_urls().get(operator_id or "")

    def _grant_for(self, m: dict, idx: int) -> dict | None:
        g = m.get("grants") or {}
        return g.get(str(idx)) or g.get(idx)

    def _set(self, m: dict, status: str, **extra):
        m["status"] = status
        m.update(extra)
        self.w.emit({"type": "mission_status", "mission_id": m["mission_id"], "status": status, "current_leg": m.get("current_leg"), **extra})

    async def _move_bytes(self, m: dict, leg: dict, stop: asyncio.Event) -> bool:
        w = self.w.window(leg["window_id"])
        wid = leg["window_id"]
        total = float(leg["bytes_mb"])
        moved = 0.0
        last_t = max(self.w.sim_t, w["start"])
        self.w.emit({"type": "leg_start", "mission_id": m["mission_id"], "leg": leg, "window_id": wid})
        last_emit = 0.0
        while moved < total - 1e-9:
            if stop.is_set():
                return False
            if wid in self.w.killed:
                leg["status"] = "FAILED"; leg["fail_reason"] = "link_killed"
                return False
            t = self.w.sim_t
            if t > w["end"]:
                leg["status"] = "FAILED"; leg["fail_reason"] = "window_closed"
                self.w.emit({"type": "leg_failed", "mission_id": m["mission_id"], "leg": leg, "reason": "window closed before transfer completed", "bytes_moved_mb": round(moved, 3)})
                return False
            dt = max(0.0, t - last_t)
            last_t = t
            moved = min(total, moved + w["bandwidth_mbps"] * dt / 8.0)
            self.w.moved_mb[wid] = self.w.moved_mb.get(wid, 0.0) + w["bandwidth_mbps"] * dt / 8.0
            leg["bytes_moved_mb"] = round(moved, 4)
            now = time.monotonic()
            if now - last_emit > 0.2 or moved >= total:
                last_emit = now
                self.w.bus.emit({"type": "transfer_progress", "sim_t": round(t, 2), "mission_id": m["mission_id"], "window_id": wid, "from": leg["from"], "to": leg["to"],
                                 "bytes_moved_mb": round(moved, 3), "bytes_total_mb": round(total, 3), "pct": round(100 * moved / total, 1) if total else 100}, keep=False)
            await asyncio.sleep(0.05)
        return True

    async def _post(self, url: str, body: dict, timeout: float = 120) -> tuple[int, dict]:
        async with httpx.AsyncClient(timeout=timeout) as c:
            try:
                r = await c.post(url, json=body)
                try:
                    data = r.json()
                except Exception:
                    data = {"raw": r.text[:500]}
                return r.status_code, data
            except Exception as e:  # connection refused etc.
                return 0, {"error": "unreachable", "detail": str(e)}

    async def _run(self, mission_id: str, stop: asyncio.Event, resume: bool):
        m = self.w.missions[mission_id]
        w = self.w
        plan = m["plan"]
        legs = plan["legs"]
        m["fidelity"] = plan.get("fidelity") or m.get("fidelity") or "full"
        if not resume:
            w.narrate("executing", f"Plan '{plan.get('label')}' committed ({m['fidelity']} fidelity). Executing {len(legs)} legs across {len({l.get('operator_id') for l in legs if l.get('operator_id')})} independent operators.", mission_id)
        # Low-fidelity plan: the product is a real downsampled crop produced at the source, no on-orbit analysis.
        if m["fidelity"] == "low" and not m.get("result"):
            try:
                sc = m["mission"].get("scene") or {}
                degraded = m["mission"].get("degraded") or {}
                b64, nbytes = make_degraded_crop(str(config.ROOT / sc.get("image_file", "data/papua_VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1.jpg")))
                m["result"] = {"kind": "raw_crop", "fidelity": "low",
                               "summary": {"note": "downsampled crop delivered without on-orbit analysis", "bbox": sc.get("bbox"), "scale": "1/8",
                                           "real_bytes": nbytes, "modeled_mb": degraded.get("payload_mb", plan.get("payload_mb"))},
                               "thumbnail_b64": b64, "geojson": {"type": "FeatureCollection", "features": []}}
                m["committed"] = {"node_id": m["mission"]["source_node"], "result_mb": float(degraded.get("payload_mb", plan.get("payload_mb") or 40)), "fidelity": "low"}
                w.emit({"type": "result", "mission_id": mission_id, "fidelity": "low", "node_id": m["mission"]["source_node"], "result": {"kind": "raw_crop", "summary": m["result"]["summary"]}})
                w.narrate("executing", f"{m['mission']['source_node']} produced the degraded product: {degraded.get('label', 'downsampled crop')} ({nbytes/1000:.0f} KB real, {m['committed']['result_mb']:.0f} MB modeled). No on-orbit analysis.", mission_id)
            except Exception as e:
                w.emit({"type": "warning", "mission_id": mission_id, "text": f"could not build degraded crop: {e}"})
        self._set(m, "RUNNING", fidelity=m["fidelity"])
        try:
            for idx, leg in enumerate(legs):
                if stop.is_set():
                    return
                if leg.get("status") == "DONE":
                    continue
                m["current_leg"] = idx
                grant = self._grant_for(m, idx)
                if leg["kind"] == "transfer":
                    win = w.window(leg["window_id"])
                    if win is None:
                        leg["status"] = "FAILED"; leg["fail_reason"] = "unknown window"
                        self._set(m, "REPLAN_REQUIRED", reason="unknown window"); return
                    # wait for window
                    await w.clock.sleep_until(win["start"], stop)
                    if stop.is_set():
                        return
                    if leg["window_id"] in w.killed:
                        leg["status"] = "FAILED"; leg["fail_reason"] = "link_killed"
                        self._set(m, "REPLAN_REQUIRED", reason=f"link {leg['window_id']} is down"); return
                    is_downlink = leg["to"] in w.gs
                    from_node = w.nodes.get(leg["from"])
                    needs_grant = is_downlink and from_node is not None and (from_node.get("capability") or {}).get("type") == "relay"
                    if needs_grant:
                        if not grant:
                            leg["status"] = "FAILED"; leg["fail_reason"] = "no grant"
                            w.emit({"type": "grant_rejected", "mission_id": mission_id, "reason": "no grant for relay downlink", "leg": idx})
                            self._set(m, "REPLAN_REQUIRED", reason="no grant for relay downlink"); return
                        url = self._url(leg.get("operator_id"), grant)
                        payload = base64.b64encode(json.dumps(m.get("result") or {"note": "raw scene"}).encode()).decode()
                        body = {"grant": grant, "world_assertion": w.assertion(leg["window_id"]), "payload_b64": payload, "mission_id": mission_id,
                                "bytes_mb": leg["bytes_mb"]}
                        w.emit({"type": "fulfilment_request", "mission_id": mission_id, "op": "transmit", "node_id": leg["from"], "grant_id": grant.get("grant_id"), "leg": idx})
                        code, data = await self._post(f"{url}/transmit", body)
                        if code != 200:
                            leg["status"] = "FAILED"; leg["fail_reason"] = data.get("reason") or data.get("error") or f"http {code}"
                            w.emit({"type": "grant_rejected", "mission_id": mission_id, "node_id": leg["from"], "grant_id": grant.get("grant_id"), "reason": leg["fail_reason"], "detail": data, "leg": idx})
                            w.narrate("disruption", f"{leg['from']} refused the transmit grant: {leg['fail_reason']}. Replanning.", mission_id)
                            self._set(m, "REPLAN_REQUIRED", reason=leg["fail_reason"]); return
                        leg["attestation"] = data.get("attestation")
                    ok = await self._move_bytes(m, leg, stop)
                    if stop.is_set():
                        return
                    if not ok:
                        reason = leg.get("fail_reason", "transfer failed")
                        if reason == "link_killed":
                            w.emit({"type": "leg_failed", "mission_id": mission_id, "leg": leg, "reason": "link down"})
                        w.narrate("disruption", f"Transfer {leg['from']}→{leg['to']} failed: {reason}. Committed results are preserved; replanning from {m.get('committed', {}).get('node_id', leg['from'])}.", mission_id)
                        self._set(m, "REPLAN_REQUIRED", reason=reason); return
                    leg["status"] = "DONE"
                    w.emit({"type": "leg_done", "mission_id": mission_id, "leg": leg, "attestation": leg.get("attestation")})
                    if is_downlink:
                        m["delivered_sim_t"] = round(w.sim_t, 2)
                        m["delivery_latency_s"] = round(w.sim_t - m.get("arrival_sim_t", 0), 1)
                        self._set(m, "DELIVERED", delivered_sim_t=m["delivered_sim_t"], fidelity=m.get("fidelity", "full"))
                        w.emit({"type": "delivered", "mission_id": mission_id, "ground_station": leg["to"], "sim_t": round(w.sim_t, 2), "deadline_sim_t": m["mission"]["deadline_sim_t"], "result": m.get("result"), "total_paid_usd": m.get("total_paid_usd"), "fidelity": m.get("fidelity", "full")})
                        w.narrate("delivered", f"{'Full-fidelity analysis' if m.get('fidelity', 'full') == 'full' else 'Low-fidelity crop'} delivered to {leg['to']} at T+{int(w.sim_t)}s (deadline T+{m['mission']['deadline_sim_t']}s). Audit: grants, receipts and attestations recorded.", mission_id)
                        return
                elif leg["kind"] == "compute":
                    if not grant:
                        leg["status"] = "FAILED"; leg["fail_reason"] = "no grant"
                        w.emit({"type": "grant_rejected", "mission_id": mission_id, "reason": "no grant for compute", "leg": idx})
                        self._set(m, "REPLAN_REQUIRED", reason="no grant for compute"); return
                    url = self._url(leg.get("operator_id"), grant)
                    start_t = w.sim_t
                    node = w.nodes[leg["node"]]
                    cs = float((node.get("capability") or {}).get("modeled_compute_s", leg.get("duration_s", 30)))
                    body = {"grant": grant, "world_assertion": w.assertion(leg["window_id"]), "payload_url": f"{config.SIM_PUBLIC_URL}/scene/image",
                            "mission_id": mission_id, "params": {"model": leg.get("model"), "op": leg.get("op"), "bbox": m["mission"].get("scene", {}).get("bbox"),
                                                                 "hotspots_url": f"{config.SIM_PUBLIC_URL}/scene/hotspots"}}
                    w.emit({"type": "leg_start", "mission_id": mission_id, "leg": leg, "window_id": leg["window_id"]})
                    w.emit({"type": "fulfilment_request", "mission_id": mission_id, "op": "execute", "node_id": leg["node"], "grant_id": grant.get("grant_id"), "leg": idx})
                    post = asyncio.create_task(self._post(f"{url}/execute", body, timeout=180))
                    await w.clock.sleep_until(start_t + cs, stop)
                    code, data = await post
                    if stop.is_set():
                        return
                    if code != 200:
                        leg["status"] = "FAILED"; leg["fail_reason"] = data.get("reason") or data.get("error") or f"http {code}"
                        w.emit({"type": "grant_rejected", "mission_id": mission_id, "node_id": leg["node"], "grant_id": grant.get("grant_id"), "reason": leg["fail_reason"], "detail": data, "leg": idx})
                        w.narrate("disruption", f"{leg['node']} refused the compute grant: {leg['fail_reason']}. Replanning.", mission_id)
                        self._set(m, "REPLAN_REQUIRED", reason=leg["fail_reason"]); return
                    m["result"] = data.get("result")
                    leg["attestation"] = data.get("attestation")
                    leg["status"] = "DONE"
                    result_mb = len(json.dumps(m["result"] or {}).encode()) / 1e6
                    m["committed"] = {"node_id": leg["node"], "result_mb": round(max(result_mb, 0.001), 4)}
                    w.emit({"type": "leg_done", "mission_id": mission_id, "leg": leg, "attestation": leg.get("attestation"), "committed": m["committed"]})
                    summ = (m["result"] or {}).get("summary") or {}
                    w.narrate("executing", f"{leg['node']} ran {leg.get('model')} on the scene: {summ.get('clusters', '?')} fire clusters, {summ.get('fire_pixels', '?')} fire pixels. Result {m['committed']['result_mb']*1000:.0f} KB now committed at {leg['node']}.", mission_id)
            self._set(m, "FAILED", reason="plan ended without a downlink")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # keep the world alive
            self._set(m, "FAILED", reason=f"runner error: {e}")
