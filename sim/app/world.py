"""World state: sim clock, windows, nodes, event bus, world assertions."""
from __future__ import annotations

import asyncio
import csv
import json
import time
from pathlib import Path

from . import config
from .crypto import Signer
from .orbits import Orbits
from .planner import WindowView, windows_from_scenario
from .scenario import gs_ids, load_scenario, node_map


class Clock:
    def __init__(self, accel: float):
        self.accel = float(accel)
        self.paused = False
        self._base_sim = 0.0
        self._base_real = time.monotonic()

    @property
    def sim_t(self) -> float:
        if self.paused:
            return self._base_sim
        return self._base_sim + (time.monotonic() - self._base_real) * self.accel

    def _rebase(self, sim_t: float):
        self._base_sim = sim_t
        self._base_real = time.monotonic()

    def pause(self):
        self._rebase(self.sim_t); self.paused = True

    def resume(self):
        self._rebase(self._base_sim); self.paused = False

    def set_accel(self, a: float):
        self._rebase(self.sim_t); self.accel = max(0.1, float(a))

    def jump(self, to: float):
        self._rebase(max(0.0, float(to)))

    async def sleep_until(self, sim_t: float, stop: asyncio.Event | None = None):
        while self.sim_t < sim_t:
            if stop and stop.is_set():
                return
            await asyncio.sleep(0.05)


class EventBus:
    def __init__(self):
        self.clients: set[asyncio.Queue] = set()
        self.tail: list[dict] = []

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        self.clients.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        self.clients.discard(q)

    def emit(self, ev: dict, keep: bool = True):
        if keep and ev.get("type") not in ("tick", "transfer_progress"):
            self.tail.append(ev)
            self.tail = self.tail[-100:]
        for q in list(self.clients):
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                pass


class World:
    def __init__(self):
        self.load()

    def load(self):
        self.sc = load_scenario(config.SCENARIO_PATH)
        self.nodes = node_map(self.sc)
        self.gs = gs_ids(self.sc)
        self.gs_map = {g["gs_id"]: g for g in self.sc["ground_stations"]}
        self.clock = Clock(self.sc["sim"]["accel"])
        self.bus = EventBus()
        self.orbits = Orbits(self.sc, config.TLE_PATH)
        self.killed: set[str] = set()
        self.moved_mb: dict[str, float] = {}
        self.online: dict[str, bool] = {n["node_id"]: not n.get("joins_late", False) for n in self.sc["nodes"]}
        self.missions: dict[str, dict] = {}
        self.audit: dict[str, list] = {}
        self._prev_status: dict[str, str] = {}
        key_path = config.KEYS_DIR / "world.json"
        self.signer = Signer.load(key_path) if key_path.exists() else Signer.generate("world")
        self._hotspots: list[dict] | None = None

    # ---- time / windows
    @property
    def sim_t(self) -> float:
        return self.clock.sim_t

    def window(self, wid: str) -> dict | None:
        return next((w for w in self.sc["windows"] if w["window_id"] == wid), None)

    def window_status(self, w: dict, t: float | None = None) -> str:
        if w["window_id"] in self.killed:
            return "killed"
        t = self.sim_t if t is None else t
        if t < w["start"]:
            return "future"
        if t <= w["end"]:
            return "open"
        return "closed"

    def window_views(self) -> list[WindowView]:
        statuses = {w["window_id"]: self.window_status(w) for w in self.sc["windows"]}
        return windows_from_scenario(self.sc, statuses, self.moved_mb)

    def windows_json(self) -> list[dict]:
        out = []
        for w in self.sc["windows"]:
            cap = w["bandwidth_mbps"] * (w["end"] - w["start"]) / 8.0
            out.append({**w, "status": self.window_status(w), "capacity_mb": round(cap, 1),
                        "moved_mb": round(self.moved_mb.get(w["window_id"], 0.0), 3),
                        "remaining_mb": round(cap - self.moved_mb.get(w["window_id"], 0.0), 1)})
        return out

    def offline_nodes(self) -> set[str]:
        return {n for n, on in self.online.items() if not on}

    def assertion(self, window_id: str) -> dict:
        w = self.window(window_id)
        t = self.sim_t
        body = {"sim_t": round(t, 3), "window_id": window_id, "open": bool(w and self.window_status(w) == "open"),
                "link": [w["from"], w["to"]] if w else None, "bandwidth_mbps": w["bandwidth_mbps"] if w else None,
                "window": {"start": w["start"], "end": w["end"]} if w else None,
                "issued_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        return self.signer.sign(body)

    # ---- events
    def emit(self, ev: dict):
        ev = {"sim_t": round(self.sim_t, 2), "ts": time.time(), **ev}
        mid = ev.get("mission_id")
        targets = [mid] if mid else [m for m, s in self.missions.items() if s.get("status") in ("PLANNED", "RUNNING", "REPLAN_REQUIRED")]
        for m in targets:
            self.audit.setdefault(m, []).append(ev)
            if m in self.missions:
                self.missions[m]["audit"] = self.audit[m][-200:]
        self.bus.emit(ev)
        return ev

    def narrate(self, act: str, text: str, mission_id: str | None = None):
        ev = {"type": "narration", "act": act, "text": text}
        if mission_id:
            ev["mission_id"] = mission_id
        return self.emit(ev)

    # ---- state
    def node_states(self) -> list[dict]:
        out = []
        for n in self.sc["nodes"]:
            pos = self.orbits.at(n["node_id"], self.sim_t)
            out.append({"node_id": n["node_id"], "role": n["role"], "operator_id": n["operator_id"], "operator_name": n.get("operator_name"),
                        "color": n.get("color"), "online": self.online.get(n["node_id"], True), "tle_name": n.get("tle_name"),
                        "lat": pos[0] if pos else None, "lon": pos[1] if pos else None, "alt_km": pos[2] if pos else None,
                        "capability": n.get("capability"), "onboard": n.get("onboard")})
        return out

    def state(self) -> dict:
        return {"scenario_id": self.sc["scenario_id"], "epoch_utc": self.sc["epoch_utc"], "sim_t": round(self.sim_t, 2),
                "sim_t_int": int(self.sim_t), "real_accel": self.clock.accel, "paused": self.clock.paused,
                "nodes": self.node_states(), "ground_stations": self.sc["ground_stations"], "windows": self.windows_json(),
                "missions": {k: {kk: vv for kk, vv in v.items() if kk not in ("audit",)} for k, v in self.missions.items()},
                "mission_template": self.sc["mission"], "disruptions": self.sc.get("disruptions", []),
                "events_tail": self.bus.tail[-100:], "world_kid": self.signer.kid, "world_public_key": self.signer.public_key}

    def hotspots(self) -> list[dict]:
        if self._hotspots is None:
            bbox = self.sc["mission"]["scene"]["bbox"]
            path = config.ROOT / self.sc["mission"]["scene"]["truth_csv"]
            rows = []
            if path.exists():
                with path.open() as f:
                    for r in csv.DictReader(f):
                        lat, lon = float(r["latitude"]), float(r["longitude"])
                        if bbox[0] <= lat <= bbox[2] and bbox[1] <= lon <= bbox[3]:
                            rows.append({"lat": lat, "lon": lon, "frp": float(r.get("frp") or 0), "confidence": r.get("confidence"),
                                         "acq_date": r.get("acq_date"), "acq_time": r.get("acq_time"), "bright_ti4": float(r.get("bright_ti4") or 0)})
            self._hotspots = rows
        return self._hotspots

    # ---- tick loop
    async def tick_loop(self):
        last_emit = 0.0
        while True:
            t = self.sim_t
            for w in self.sc["windows"]:
                st = self.window_status(w, t)
                prev = self._prev_status.get(w["window_id"])
                if prev != st:
                    self._prev_status[w["window_id"]] = st
                    if prev is not None and st == "open":
                        self.emit({"type": "window_open", "window_id": w["window_id"], "from": w["from"], "to": w["to"], "bandwidth_mbps": w["bandwidth_mbps"], "end": w["end"]})
                    elif prev == "open" and st == "closed":
                        self.emit({"type": "window_close", "window_id": w["window_id"], "from": w["from"], "to": w["to"]})
            now = time.monotonic()
            if now - last_emit >= 0.25:
                last_emit = now
                self.bus.emit({"type": "tick", "sim_t": round(t, 2), "sim_t_int": int(t), "accel": self.clock.accel, "paused": self.clock.paused, "ts": time.time()}, keep=False)
            await asyncio.sleep(0.05)
