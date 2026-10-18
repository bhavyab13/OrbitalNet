"""OrbitalNet world simulator — FastAPI app (docs/API.md §1)."""
from __future__ import annotations

import asyncio
import json
import os
import shlex
import subprocess
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import config
from .planner import plan as run_planner
from .runner import Runner
from .world import World

world = World()
runner = Runner(world)
_tick_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _tick_task
    _tick_task = asyncio.create_task(world.tick_loop())
    try:
        yield
    finally:
        runner.stop_all()
        if _tick_task:
            _tick_task.cancel()


app = FastAPI(title="OrbitalNet Sim", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ---------- state
@app.get("/")
def root():
    return {"service": "orbitalnet-sim", "sim_t": round(world.sim_t, 2), "scenario": world.sc["scenario_id"], "docs": "/docs", "ws": "/ws"}


@app.get("/state")
def state():
    return world.state()


@app.get("/keys")
def keys():
    return {"kid": world.signer.kid, "public_key": world.signer.public_key}


@app.get("/scenario")
def scenario():
    return world.sc


@app.get("/positions")
def positions(frm: float = Query(0, alias="from"), to: float | None = None, step: float = 10):
    to = world.sc["sim"]["horizon_s"] if to is None else to
    return {n: world.orbits.series(n, frm, to, step) for n in world.orbits.cache}


@app.get("/windows")
def windows():
    return world.windows_json()


@app.get("/assert")
def assertion(window_id: str):
    if world.window(window_id) is None:
        raise HTTPException(404, "unknown window")
    return world.assertion(window_id)


# ---------- scene
def _scene_path(key: str):
    p = config.ROOT / world.sc["mission"]["scene"][key]
    if not p.exists():
        raise HTTPException(404, f"missing {p}")
    return p


@app.get("/scene/image")
def scene_image():
    return FileResponse(_scene_path("image_file"), media_type="image/jpeg")


@app.get("/scene/truecolor")
def scene_truecolor():
    return FileResponse(_scene_path("truecolor_file"), media_type="image/jpeg")


@app.get("/scene/hotspots")
def scene_hotspots():
    return {"bbox": world.sc["mission"]["scene"]["bbox"], "count": len(world.hotspots()), "hotspots": world.hotspots()}


# ---------- planner
@app.post("/plan")
def plan(req: dict[str, Any]):
    mid = req.get("mission_id") or world.sc["mission"]["mission_id"]
    ms = world.missions.get(mid)
    # defaults come from the running mission (which may carry judge/buyer overrides), else the scenario
    m = (ms or {}).get("mission") or world.sc["mission"]
    req = {**{"mission_id": m["mission_id"], "source_node": m["source_node"], "payload_mb": m["payload_mb"], "op": m["op"], "model": m["model"],
              "result_mb_estimate": m["result_mb_estimate"], "deadline_sim_t": m["deadline_sim_t"], "budget_usd": m["budget_usd"],
              "degraded": m.get("degraded"), "required_fidelity": m.get("required_fidelity", "any")}, **req}
    if req.get("now_sim_t") is None:
        req["now_sim_t"] = world.sim_t
    # a running mission with committed state → replan from there unless caller overrides
    if ms and ms.get("committed") and "committed" not in req:
        req["committed"] = ms["committed"]
    if ms and "budget_usd" not in req:
        req["budget_usd"] = ms.get("budget_remaining_usd", m["budget_usd"])
    plans = run_planner(req, world.window_views(), world.nodes, world.gs, offline=world.offline_nodes())
    world.emit({"type": "plans_computed", "mission_id": mid, "now_sim_t": req["now_sim_t"], "n": len(plans),
                "feasible": sum(p["feasible"] for p in plans), "summary": [{"plan_id": p["plan_id"], "label": p["label"], "feasible": p["feasible"], "cost_usd": p["cost_usd"], "delivery_sim_t": p["delivery_sim_t"]} for p in plans[:8]]})
    return {"plans": plans, "now_sim_t": req["now_sim_t"], "committed": req.get("committed")}


# ---------- missions
def _total_paid(grants: dict) -> float:
    return round(sum(float(g.get("price_usd", 0)) for g in (grants or {}).values() if isinstance(g, dict)), 4)


@app.post("/missions")
async def create_mission(body: dict[str, Any]):
    mission = {**world.sc["mission"], **(body.get("mission") or {})}
    plan_ = body.get("plan")
    if not plan_ or "legs" not in plan_:
        raise HTTPException(400, "plan with legs required")
    grants = {str(k): v for k, v in (body.get("grants") or {}).items()}
    mid = mission["mission_id"]
    runner.stop(mid)
    prior = world.missions.get(mid, {})
    paid = _total_paid(grants) + float(prior.get("total_paid_usd", 0) if body.get("keep_history") else 0)
    ms = {"mission_id": mid, "mission": mission, "plan": plan_, "grants": grants, "status": "PLANNED", "current_leg": None,
          "arrival_sim_t": prior.get("arrival_sim_t", round(world.sim_t, 2)), "committed": None, "result": None,
          "total_paid_usd": paid, "budget_remaining_usd": round(float(mission["budget_usd"]) - paid, 4), "replans": 0, "audit": world.audit.get(mid, [])[-200:]}
    world.missions[mid] = ms
    for i, leg in enumerate(plan_["legs"]):
        leg["status"] = "PENDING"
    world.emit({"type": "plan_chosen", "mission_id": mid, "plan_id": plan_.get("plan_id"), "label": plan_.get("label"), "cost_usd": plan_.get("cost_usd"), "delivery_sim_t": plan_.get("delivery_sim_t"), "grants": list(grants.keys())})
    world.narrate("path-found", f"Mission {mid}: plan '{plan_.get('label')}' selected — delivery T+{int(plan_.get('delivery_sim_t', 0))}s for ${plan_.get('cost_usd', 0):.2f}.", mid)
    runner.start(mid)
    return {"mission_id": mid, "status": ms["status"]}


@app.post("/missions/{mid}/resume")
async def resume_mission(mid: str, body: dict[str, Any]):
    ms = world.missions.get(mid)
    if not ms:
        raise HTTPException(404, "unknown mission")
    plan_ = body.get("plan")
    if not plan_ or "legs" not in plan_:
        raise HTTPException(400, "plan with legs required")
    grants = {str(k): v for k, v in (body.get("grants") or {}).items()}
    runner.stop(mid)
    ms["previous_plans"] = ms.get("previous_plans", []) + [ms["plan"]]
    ms["previous_grants"] = {**ms.get("previous_grants", {}), **{f"r{ms.get('replans', 0)}:{k}": v for k, v in ms["grants"].items()}}
    ms["plan"] = plan_
    ms["grants"] = grants
    ms["replans"] = ms.get("replans", 0) + 1
    # Only grants not seen before count as new spend (the broker re-sends every grant on resume).
    known_ids = {g.get("grant_id") for g in list(ms.get("previous_grants", {}).values()) if isinstance(g, dict)}
    new_grants = {k: g for k, g in grants.items() if isinstance(g, dict) and g.get("grant_id") not in known_ids}
    ms["total_paid_usd"] = round(ms.get("total_paid_usd", 0) + _total_paid(new_grants) - float(body.get("refunded_usd", 0)), 4)
    ms["budget_remaining_usd"] = round(float(ms["mission"]["budget_usd"]) - ms["total_paid_usd"], 4)
    for leg in plan_["legs"]:
        leg.setdefault("status", "PENDING")
    world.emit({"type": "plan_chosen", "mission_id": mid, "plan_id": plan_.get("plan_id"), "label": plan_.get("label"), "cost_usd": plan_.get("cost_usd"), "delivery_sim_t": plan_.get("delivery_sim_t"), "resume": True, "replan_n": ms["replans"]})
    world.narrate("replan", f"Replan #{ms['replans']}: '{plan_.get('label')}' from {ms.get('committed', {}).get('node_id') if ms.get('committed') else ms['mission']['source_node']} — delivery T+{int(plan_.get('delivery_sim_t', 0))}s, +${plan_.get('cost_usd', 0):.2f}. Fulfilled grants preserved.", mid)
    runner.start(mid, resume=True)
    return {"mission_id": mid, "status": ms["status"], "replans": ms["replans"]}


@app.get("/missions/{mid}")
def get_mission(mid: str):
    ms = world.missions.get(mid)
    if not ms:
        raise HTTPException(404, "unknown mission")
    legs = ms["plan"]["legs"]
    return {**ms, "legs": legs, "audit": world.audit.get(mid, [])[-200:], "sim_t": round(world.sim_t, 2), "deadline_sim_t": ms["mission"]["deadline_sim_t"]}


@app.post("/missions/{mid}/infeasible")
async def mark_infeasible(mid: str, body: dict[str, Any]):
    """The buyer/broker declares that no feasible plan exists (honest failure)."""
    ms = world.missions.get(mid)
    if not ms:
        raise HTTPException(404, "unknown mission")
    runner.stop(mid)
    ms["status"] = "INFEASIBLE"; ms["reason"] = body.get("reason", "no feasible plan")
    world.emit({"type": "infeasible", "mission_id": mid, "reason": ms["reason"]})
    world.narrate("replan", f"No feasible path remains: {ms['reason']}. Mission declared INFEASIBLE — the protocol never fabricates delivery.", mid)
    return {"mission_id": mid, "status": ms["status"]}


# ---------- clock / disruptions / events
@app.post("/clock")
def clock(body: dict[str, Any]):
    a = body.get("action")
    if a == "pause":
        world.clock.pause()
    elif a == "resume":
        world.clock.resume()
    elif a == "set_accel":
        world.clock.set_accel(float(body.get("accel", 4)))
    elif a == "jump":
        world.clock.jump(float(body.get("to_sim_t", 0)))
    else:
        raise HTTPException(400, "action must be pause|resume|set_accel|jump")
    world.emit({"type": "clock", "action": a, "accel": world.clock.accel, "paused": world.clock.paused})
    return world.state()


async def _op_post(operator_id: str, path: str, body: dict, admin: bool = False) -> dict:
    base = config.operator_urls().get(operator_id)
    if not base:
        return {"error": "no url for operator", "operator_id": operator_id}
    headers = {"X-Admin-Token": config.ADMIN_TOKEN} if admin else {}
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(f"{base}{path}", json=body, headers=headers)
            try:
                return {"status": r.status_code, **(r.json() if r.content else {})}
            except Exception:
                return {"status": r.status_code, "raw": r.text[:300]}
    except Exception as e:
        return {"error": "unreachable", "detail": str(e)}


@app.post("/disrupt")
async def disrupt(body: dict[str, Any]):
    t = body.get("type")
    ev: dict = {"type": t, "label": body.get("label")}
    if t == "kill_link":
        wid = body["window_id"]
        w = world.window(wid)
        if not w:
            raise HTTPException(404, "unknown window")
        world.killed.add(wid)
        ev = {"type": "link_killed", "window_id": wid, "from": w["from"], "to": w["to"], "label": body.get("label")}
        world.emit(ev)
        world.narrate("disruption", body.get("label") or f"Link {w['from']}→{w['to']} ({wid}) is down.")
        # refunds for unfulfilled paid grants on this window + replan if a running mission depends on it
        for mid, ms in world.missions.items():
            if ms.get("status") not in ("RUNNING", "PLANNED"):
                continue
            legs = ms["plan"]["legs"]
            for i, leg in enumerate(legs):
                if leg.get("window_id") == wid and leg.get("status") != "DONE":
                    g = (ms.get("grants") or {}).get(str(i))
                    if g:
                        res = await _op_post(g.get("operator_id") or leg.get("operator_id"), "/refund", {"grant_id": g.get("grant_id"), "reason": "provider-side link outage", "mission_id": mid})
                        world.emit({"type": "refund", "mission_id": mid, "grant_id": g.get("grant_id"), "operator_id": g.get("operator_id"), "amount_usd": g.get("price_usd"), "voucher": res})
                        if res.get("status") == 200:
                            ms["total_paid_usd"] = round(ms.get("total_paid_usd", 0) - float(g.get("price_usd", 0)), 4)
                            ms["budget_remaining_usd"] = round(float(ms["mission"]["budget_usd"]) - ms["total_paid_usd"], 4)
                    if ms["status"] == "RUNNING" and (ms.get("current_leg") is None or ms["current_leg"] <= i):
                        runner.stop(mid)
                        leg["status"] = "FAILED"; leg["fail_reason"] = "link_killed"
                        ms["status"] = "REPLAN_REQUIRED"; ms["reason"] = f"link {wid} down"
                        world.emit({"type": "replan_required", "mission_id": mid, "reason": ms["reason"], "committed": ms.get("committed"), "budget_remaining_usd": ms.get("budget_remaining_usd")})
                        world.emit({"type": "mission_status", "mission_id": mid, "status": "REPLAN_REQUIRED", "reason": ms["reason"]})
                        world.narrate("replan", f"Mission {mid} can no longer use {wid}. Fulfilled work at {ms.get('committed', {}).get('node_id') if ms.get('committed') else 'source'} is preserved; buyer must find a new delivery path.", mid)
                    break
        return {"ok": True, "event": ev}
    if t == "restore_link":
        world.killed.discard(body["window_id"])
        ev = {"type": "link_restored", "window_id": body["window_id"]}
        world.emit(ev)
        return {"ok": True, "event": ev}
    if t == "competing_reserve":
        node = body["node_id"]
        op = world.nodes[node]["operator_id"]
        frac = float(body.get("fraction", 0.0 if body.get("fail_next_hold") else 0.6))
        res = await _op_post(op, "/admin/capacity", {"fraction_taken": frac, "label": body.get("label", "competing mission"), "fail_next_hold": bool(body.get("fail_next_hold", False))}, admin=True)
        ev = {"type": "competing_mission", "node_id": node, "operator_id": op, "fraction": frac, "fail_next_hold": bool(body.get("fail_next_hold", False)), "operator_response": res}
        world.emit(ev)
        if body.get("fail_next_hold"):
            world.narrate("disruption", body.get("label") or f"{node}'s operator will withdraw its capacity at the moment of commitment (E1).")
        elif frac == 0:
            world.narrate("disruption", body.get("label") or f"{node}'s operator restored its capacity.")
        else:
            world.narrate("disruption", body.get("label") or f"A competing mission just took {int(100*frac)}% of {node}'s capacity. Quotes reprice under scarcity.")
        return {"ok": True, "event": ev}
    if t == "launch_provider":
        node = body["node_id"]
        cmd = os.environ.get("LAUNCH_CMD_" + node.replace("-", "_").replace(" ", "_"))
        launched = False
        if cmd:
            subprocess.Popen(cmd, shell=True, cwd=str(config.ROOT))
            launched = True
        world.online[node] = True
        ev = {"type": "provider_online", "node_id": node, "operator_id": world.nodes[node]["operator_id"], "launched_process": launched}
        world.emit(ev)
        world.narrate("disruption", body.get("label") or f"New provider {world.nodes[node].get('operator_name')} ({node}) is coming online and registering its manifest.")
        return {"ok": True, "event": ev}
    if t == "misbehave":
        node = body["node_id"]
        op = world.nodes[node]["operator_id"]
        mode = body.get("mode", "over_attest")
        res = await _op_post(op, "/admin/misbehave", {"mode": mode, "label": body.get("label")}, admin=True)
        ev = {"type": "misbehave", "node_id": node, "operator_id": op, "mode": mode, "operator_response": res}
        world.emit(ev)
        world.narrate("disruption", body.get("label") or f"The judge made {world.nodes[node].get('operator_name', op)} over-report its usage. Watch reconciliation.")
        return {"ok": True, "event": ev}
    if t == "revoke":
        node = body["node_id"]
        op = world.nodes[node]["operator_id"]
        res = await _op_post(op, "/admin/revoke", {"all_unfulfilled": True, "reason": body.get("label", "operator revoked capacity")}, admin=True)
        ev = {"type": "revoked", "node_id": node, "operator_id": op, "operator_response": res}
        world.emit(ev)
        for mid, ms in world.missions.items():
            if ms.get("status") == "RUNNING":
                for i, leg in enumerate(ms["plan"]["legs"]):
                    if leg.get("operator_id") == op and leg.get("status") != "DONE":
                        runner.stop(mid)
                        ms["status"] = "REPLAN_REQUIRED"; ms["reason"] = f"{op} revoked unfulfilled grants"
                        world.emit({"type": "replan_required", "mission_id": mid, "reason": ms["reason"], "committed": ms.get("committed")})
                        break
        return {"ok": True, "event": ev}
    raise HTTPException(400, "unknown disruption type")


@app.post("/events")
def post_event(ev: dict[str, Any]):
    if "type" not in ev:
        raise HTTPException(400, "type required")
    if ev["type"] == "provider_online" and ev.get("node_id") in world.online:
        world.online[ev["node_id"]] = True
    if ev["type"] == "provider_offline" and ev.get("node_id") in world.online:
        world.online[ev["node_id"]] = False
    # keep a running total of what the buyer paid
    if ev["type"] == "payment" and ev.get("mission_id") in world.missions:
        pass
    return {"ok": True, "event": world.emit(ev)}


@app.post("/reset")
async def reset():
    runner.stop_all()
    world.load()
    # best-effort: reset every known operator's capacity/grants so scarcity pricing starts fresh
    async with httpx.AsyncClient(timeout=3.0) as cx:
        for op_id, base in config.operator_urls().items():
            try:
                await cx.post(f"{base}/admin/reset", headers={"X-Admin-Token": os.environ.get("ADMIN_TOKEN", "")}, json={})
            except Exception:
                pass
    world.emit({"type": "reset"})
    return world.state()


@app.websocket("/ws")
async def ws(socket: WebSocket):
    await socket.accept()
    q = world.bus.subscribe()
    try:
        await socket.send_text(json.dumps({"type": "hello", "state": world.state()}))
        while True:
            ev = await q.get()
            await socket.send_text(json.dumps(ev, default=str))
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        world.bus.unsubscribe(q)
