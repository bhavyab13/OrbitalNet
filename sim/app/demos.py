"""One-button demo programs (docs/API.md §1 "Demos") + live Stripe / InstaBox proxies.

Every step is advanced by REAL world events (buyer narration, mission status, operator events);
cues (outage, late provider, fast-forward) fire on mission state, never on wall-clock guesses.
"""
from __future__ import annotations

import asyncio
import json
import os
import shlex
import signal
import subprocess
import time
from datetime import datetime, timezone
from typing import Any, Callable

import httpx

from . import config

NODE22 = "/opt/homebrew/opt/node@22/bin"
INSTABOX = "/Users/bhavyabellannagari/.local/bin"
SIM_SELF = os.environ.get("SIM_SELF_URL", f"http://127.0.0.1:{os.environ.get('PORT', '8000')}")
DEMO_ACCEL = float(os.environ.get("DEMO_ACCEL", "2"))

BOX_TO_NODE = {"orbital-foundry": ("PHISAT-2", "orbital-foundry", "compute"),
               "lumen-relay": ("EDRS-C", "lumen-relay", "relay"),
               "northstar-relay": ("STARLINK-3005", "northstar-relay", "relay")}

DEMOS: list[dict] = [
    {"id": 1, "title": "Impossible alone", "subtitle": "One satellite can't make the deadline. Two strangers' satellites can — if the agent can buy both safely.",
     "mission_id": "fire-001", "e1": True,
     "steps": [
        {"title": "Mission arrives", "detail": "No single satellite can deliver before the deadline: the imaging satellite's own ground pass is after T+720s."},
        {"title": "Discovery and signed quotes", "detail": "The agent finds two independently operated satellites, verifies their signed manifests and gets window-bound quotes. The plan table shows what is physically and economically feasible."},
        {"title": "E1: a provider withdraws at commit", "detail": "The relay refuses its hold between quote and commit. Every other hold is released. $0 moved."},
        {"title": "Conditional commit", "detail": "Holds succeed on both legs, then two Stripe MPP payments and two signed grants bound to receipts and contact windows."},
        {"title": "Crosslink + inference on InstaBox", "detail": "180 MB flows to PHISAT-2 during its 90 s window. The satellite verifies the grant offline with its own key and the world's signed clock, then runs real fire detection."},
        {"title": "Metered downlink (Stripe session)", "detail": "Relay bytes are paid per 100 KB through an MPP session that settles to the Stripe balance a cent at a time."},
        {"title": "Delivered + reconciled", "detail": "Receipt ↔ grant ↔ attestation agree for every grant."}]},
    {"id": 2, "title": "Outage, refund, and a stranger", "subtitle": "The ground station dies after the work is done. The result survives, the money comes back, and a provider nobody has met finishes the job.",
     "mission_id": "fire-001", "e1": False,
     "steps": [
        {"title": "Mission arrives", "detail": "Same mission: full-fidelity fire perimeters within 12 minutes."},
        {"title": "Discover, quote, pay", "detail": "Two operators, two Stripe MPP payments, two signed grants."},
        {"title": "Inference on PHISAT-2 (InstaBox)", "detail": "Real fire detection on the real scene; the compute grant is fulfilled and attested."},
        {"title": "E2: ground-station outage", "detail": "Punta Arenas goes down after compute. The result is preserved on PHISAT-2; the relay refunds its unfulfilled grant with a signed voucher."},
        {"title": "No feasible path — the agent waits", "detail": "The agent refuses to invent a result and watches the marketplace until the deadline."},
        {"title": "A stranger boots on InstaBox", "detail": "Northstar Relay starts from a snapshot, publishes a signed manifest, is discovered, verified and paid — no integration code."},
        {"title": "Fast-forward to the Starlink window", "detail": "Crosslink to STARLINK-3005, then a metered downlink to Oregon (Stripe session)."},
        {"title": "Delivered + reconciled", "detail": "Three grants: two fulfilled, one refunded. Books balance."}]},
    {"id": 3, "title": "Intent changes the deal, and a provider lies", "subtitle": "A $1.50 budget makes the agent buy the cheap product. Reconciliation catches a relay over-reporting what it did.",
     "mission_id": "fire-003", "e1": False, "misbehave": "EDRS-C",
     "text": "Rough extent of the Papua fire complex is enough. Keep it under $1.50 and deliver within 12 minutes.", "budget": 1.5,
     "steps": [
        {"title": "Mission arrives with a tight budget", "detail": "Under $1.50 the full-fidelity analysis is infeasible; only the 40 MB low-fidelity crop fits."},
        {"title": "Agent chooses the low-fidelity crop", "detail": "Cheaper, same deadline, extent only — the mission text decides."},
        {"title": "Payment + grant (Stripe)", "detail": "One MPP reservation on the relay, one signed grant."},
        {"title": "40 MB metered through the relay", "detail": "400 units × $0.002 as a Stripe session: dozens of one-cent settlements land in the Stripe balance."},
        {"title": "Delivered (low fidelity)", "detail": "A real downsampled crop reaches the ground station."},
        {"title": "Reconciliation catches a lie", "detail": "The relay's attestation claims more usage than its grant allowed. Signed correctly, caught only by reconciliation — provider marked untrusted."}]},
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Director:
    def __init__(self, world, runner):
        self.w = world
        self.runner = runner
        self.running: int | None = None
        self.step = 0
        self.total = 0
        self.status = "idle"
        self.task: asyncio.Task | None = None
        self.proc: subprocess.Popen | None = None
        self.q: asyncio.Queue | None = None
        self.log: list[dict] = []

    # ---- public
    def status_json(self) -> dict:
        return {"running": self.running, "step": self.step, "total": self.total, "status": self.status,
                "mission_id": self._demo()["mission_id"] if self.running else None}

    def _demo(self) -> dict:
        return next(d for d in DEMOS if d["id"] == self.running)

    async def start(self, demo_id: int):
        if self.running is not None:
            raise RuntimeError("demo already running")
        demo = next((d for d in DEMOS if d["id"] == demo_id), None)
        if not demo:
            raise KeyError(demo_id)
        self.running = demo_id
        self.step = 0
        self.total = len(demo["steps"])
        self.status = "starting"
        self.task = asyncio.create_task(self._program(demo))

    async def stop(self, status: str = "STOPPED"):
        if self.running is None:
            return
        self._kill_buyer()
        self.runner.stop_all()
        if self.task and not self.task.done():
            self.task.cancel()
        await self._done(status)

    # ---- helpers
    def _emit(self, ev: dict):
        self.w.emit(ev)

    def _advance(self, demo: dict, n: int):
        if n <= self.step:
            return
        self.step = n
        st = demo["steps"][n - 1]
        self.status = f"step {n}/{self.total}"
        self._emit({"type": "demo_step", "id": demo["id"], "step": n, "total": self.total, "title": st["title"], "detail": st["detail"], "mission_id": demo["mission_id"]})

    async def _done(self, status: str):
        demo = self._demo() if self.running else None
        summary: dict[str, Any] = {}
        if demo:
            ms = self.w.missions.get(demo["mission_id"]) or {}
            summary = {"delivered_sim_t": ms.get("delivered_sim_t"), "total_paid_usd": ms.get("total_paid_usd"), "fidelity": ms.get("fidelity")}
            rec = await self._broker_get(f"/reconcile/{demo['mission_id']}")
            summary["reconcile_ok"] = rec.get("ok") if isinstance(rec, dict) else None
            summary["reconcile_summary"] = rec.get("summary") if isinstance(rec, dict) else None
            summary["violations"] = (rec.get("violations") or []) if isinstance(rec, dict) else []
            self._emit({"type": "demo_done", "id": demo["id"], "status": status, "summary": summary, "mission_id": demo["mission_id"]})
        self.status = status
        self.running = None
        self.step = 0
        if self.q is not None:
            self.w.bus.unsubscribe(self.q)
            self.q = None

    async def _self_post(self, path: str, body: dict) -> dict:
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.post(f"{SIM_SELF}{path}", json=body)
                return r.json() if r.content else {}
        except Exception as e:
            return {"error": str(e)}

    async def _broker_post(self, path: str, body: dict | None = None) -> dict:
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.post(f"{config.BROKER_URL}{path}", json=body or {})
                return r.json() if r.content else {}
        except Exception as e:
            return {"error": str(e)}

    async def _broker_get(self, path: str) -> dict:
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.get(f"{config.BROKER_URL}{path}")
                return r.json() if r.content else {}
        except Exception as e:
            return {"error": str(e)}

    def _spawn_buyer(self, demo: dict):
        args = ["npm", "run", "buyer", "--", "--auto", "--id", demo["mission_id"]]
        if demo.get("text"):
            args += ["--text", demo["text"]]
        if demo.get("budget") is not None:
            args += ["--budget", str(demo["budget"])]
        if demo.get("deadline") is not None:
            args += ["--deadline", str(demo["deadline"])]
        env = {**os.environ, "PATH": f"{NODE22}:{INSTABOX}:" + os.environ.get("PATH", "")}
        logdir = config.ROOT / ".logs"; logdir.mkdir(exist_ok=True)
        out = open(logdir / f"buyer-demo{demo['id']}.log", "w")
        self.proc = subprocess.Popen(args, cwd=str(config.ROOT / "packages" / "buyer"), env=env, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)

    def _kill_buyer(self):
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            except Exception:
                pass
        self.proc = None

    def _mission(self, demo: dict) -> dict:
        return self.w.missions.get(demo["mission_id"]) or {}

    async def _wait(self, pred: Callable[[dict | None], bool], timeout_s: float = 600) -> dict | None:
        """Wait until pred(event) is true (also evaluated on a timer with event=None)."""
        deadline = time.monotonic() + timeout_s
        if pred(None):
            return None
        while time.monotonic() < deadline:
            try:
                ev = await asyncio.wait_for(self.q.get(), timeout=0.5)
            except asyncio.TimeoutError:
                ev = None
            if pred(ev):
                return ev
            if self.proc and self.proc.poll() is not None and self.proc.returncode not in (0, None):
                raise RuntimeError(f"buyer exited with {self.proc.returncode}")
        raise TimeoutError("demo step timed out")

    @staticmethod
    def _buyer_said(ev: dict | None, needle: str) -> bool:
        return bool(ev and ev.get("type") == "narration" and ev.get("source") == "buyer" and needle in str(ev.get("text", "")))

    def _status_is(self, demo: dict, *statuses: str) -> bool:
        return self._mission(demo).get("status") in statuses

    async def _fast_forward(self, demo: dict, to_sim_t: float, label: str):
        if self.w.sim_t < to_sim_t:
            self._emit({"type": "fast_forward", "mission_id": demo["mission_id"], "from_sim_t": round(self.w.sim_t), "to_sim_t": to_sim_t, "label": label})
            self.w.narrate("fast-forward", f"Fast-forward: {label} (T+{int(self.w.sim_t)}s → T+{int(to_sim_t)}s). Nothing happens between contact windows.", demo["mission_id"])
            await self._self_post("/clock", {"action": "jump", "to_sim_t": to_sim_t})

    async def _wait_terminal(self, demo: dict, timeout_s: float = 600) -> str:
        await self._wait(lambda ev: self._status_is(demo, "DELIVERED", "INFEASIBLE", "FAILED"), timeout_s)
        return self._mission(demo).get("status", "FAILED")

    # ---- the programs
    async def _northstar_offline(self):
        """The late provider must be OFF at demo start: stop its process on the InstaBox and wait for the broker to notice."""
        env = {**os.environ, "PATH": f"{INSTABOX}:{NODE22}:" + os.environ.get("PATH", "")}
        try:
            await asyncio.to_thread(subprocess.run, ["instabox", "ssh", "northstar-relay", "--", "pkill -f 'tsx src/index.ts' || true"], capture_output=True, text=True, timeout=40, env=env)
        except Exception as e:
            self.w.emit({"type": "warning", "text": f"could not stop northstar box process: {e}"})
        self.w.online["STARLINK-3005"] = False
        for _ in range(16):
            reg = await self._broker_get("/registry")
            provs = (reg.get("providers") or []) if isinstance(reg, dict) else []
            ns = next((p for p in provs if p.get("operator_id") == "northstar-relay"), None)
            if ns is None or not ns.get("online"):
                return
            await asyncio.sleep(2)

    async def _program(self, demo: dict):
        mid = demo["mission_id"]
        try:
            self.status = "preparing (resetting world, stopping the late provider)"
            self._emit({"type": "demo_preparing", "id": demo["id"], "title": demo["title"], "mission_id": mid})
            await self._northstar_offline()
            # fresh world + broker + operators; subscribe AFTER reset (reset keeps the bus but clears state)
            await self._broker_post("/reset")
            await asyncio.sleep(0.5)
            await self._self_post("/clock", {"action": "set_accel", "accel": DEMO_ACCEL})
            self.q = self.w.bus.subscribe()
            if demo.get("e1"):
                await self._self_post("/disrupt", {"type": "competing_reserve", "node_id": "EDRS-C", "fraction": 0, "fail_next_hold": True, "label": "E1: Lumen Relay withdraws capacity at commit"})
            if demo.get("misbehave"):
                await self._self_post("/disrupt", {"type": "misbehave", "node_id": demo["misbehave"], "mode": "over_attest", "label": "Lumen Relay will over-report its usage (watch reconciliation)"})
            self._emit({"type": "demo_started", "id": demo["id"], "title": demo["title"], "subtitle": demo["subtitle"], "total": self.total, "mission_id": mid, "accel": DEMO_ACCEL})
            self._advance(demo, 1)
            self._spawn_buyer(demo)
            if demo["id"] == 1:
                await self._demo1(demo)
            elif demo["id"] == 2:
                await self._demo2(demo)
            else:
                await self._demo3(demo)
        except asyncio.CancelledError:
            return
        except Exception as e:
            self.w.narrate("error", f"Demo {demo['id']} stopped: {e}", mid)
            self._kill_buyer()
            await self._done("FAILED")
            return

    async def _demo1(self, demo: dict):
        mid = demo["mission_id"]
        await self._wait(lambda ev: self._buyer_said(ev, "Discovered"))
        self._advance(demo, 2)
        await self._wait(lambda ev: self._buyer_said(ev, "Reservation failed"))
        self._advance(demo, 3)
        await self._wait(lambda ev: self._buyer_said(ev, "Paid "))
        self._advance(demo, 4)
        await self._wait(lambda ev: bool(ev and ev.get("type") == "leg_start" and (ev.get("leg") or {}).get("kind") == "compute") or (self._mission(demo).get("committed") or {}).get("node_id") == "PHISAT-2")
        self._advance(demo, 5)
        # compute done → skip dead air to the B→C crosslink, then to the downlink
        await self._wait(lambda ev: (self._mission(demo).get("committed") or {}).get("node_id") == "PHISAT-2")
        await asyncio.sleep(2)
        await self._fast_forward(demo, 194, "next contact window (PHISAT-2 → EDRS-C) opens at T+200s")
        await self._wait(lambda ev: bool(ev and ev.get("type") == "leg_done" and (ev.get("window_id") == "w_B_C_1" or (ev.get("leg") or {}).get("window_id") == "w_B_C_1")) or (self._mission(demo).get("current_leg") or 0) >= 3, 300)
        await asyncio.sleep(1.5)
        await self._fast_forward(demo, 294, "downlink window (EDRS-C → Punta Arenas) opens at T+300s")
        await self._wait(lambda ev: bool(ev and ev.get("type") == "metered_start"), 300)
        self._advance(demo, 6)
        st = await self._wait_terminal(demo)
        if st == "DELIVERED":
            self._advance(demo, 7)
        await asyncio.sleep(1.5)
        await self._done(st)

    async def _demo2(self, demo: dict):
        mid = demo["mission_id"]
        await self._wait(lambda ev: self._buyer_said(ev, "Paid "))
        self._advance(demo, 2)
        await self._wait(lambda ev: bool(ev and ev.get("type") == "leg_start" and (ev.get("leg") or {}).get("kind") == "compute") or (self._mission(demo).get("committed") or {}).get("node_id") == "PHISAT-2")
        self._advance(demo, 3)
        await self._wait(lambda ev: (self._mission(demo).get("committed") or {}).get("node_id") == "PHISAT-2")
        # cue: outage after the work is done (never before T+125 so the green ring is visible)
        await self._wait(lambda ev: self.w.sim_t >= 125, 120)
        await asyncio.sleep(1.5)
        self._advance(demo, 4)
        await self._self_post("/disrupt", {"type": "kill_link", "window_id": "w_C_GS_1", "label": "Ground station outage at Punta Arenas"})
        await self._wait(lambda ev: self._status_is(demo, "REPLAN_REQUIRED"), 60)
        await self._wait(lambda ev: self._buyer_said(ev, "No feasible path") or self._buyer_said(ev, "Watching the marketplace"), 120)
        self._advance(demo, 5)
        await asyncio.sleep(4)
        self._advance(demo, 6)
        await self._self_post("/disrupt", {"type": "launch_provider", "node_id": "STARLINK-3005", "label": "New provider Northstar Relay comes online (InstaBox)"})
        # the Northstar leg is paid and the resumed mission is running (replans >= 1)
        await self._wait(lambda ev: self._status_is(demo, "RUNNING") and int(self._mission(demo).get("replans", 0)) >= 1, 300)
        await asyncio.sleep(2)
        self._advance(demo, 7)
        await self._fast_forward(demo, 376, "Starlink crosslink window opens at T+380s")
        await self._wait(lambda ev: bool(ev and ev.get("type") == "leg_done" and (ev.get("window_id") == "w_B_D_1" or (ev.get("leg") or {}).get("window_id") == "w_B_D_1")) or (self._mission(demo).get("current_leg") or 0) >= 1 and self.w.sim_t > 400, 300)
        await asyncio.sleep(1.5)
        await self._fast_forward(demo, 424, "downlink window (STARLINK-3005 → Oregon) opens at T+430s")
        st = await self._wait_terminal(demo)
        if st == "DELIVERED":
            self._advance(demo, 8)
        await asyncio.sleep(1.5)
        await self._done(st)

    async def _demo3(self, demo: dict):
        mid = demo["mission_id"]
        await self._wait(lambda ev: self._buyer_said(ev, "Chose"))
        self._advance(demo, 2)
        await self._wait(lambda ev: self._buyer_said(ev, "Paid "))
        self._advance(demo, 3)
        await self._wait(lambda ev: self._status_is(demo, "RUNNING"), 120)
        # crop crosslink A→C at T+40..80, then the metered downlink at T+300
        await self._wait(lambda ev: bool(ev and ev.get("type") == "leg_done") or (self._mission(demo).get("current_leg") or 0) >= 1, 300)
        await asyncio.sleep(1.5)
        await self._fast_forward(demo, 294, "downlink window (EDRS-C → Punta Arenas) opens at T+300s")
        await self._wait(lambda ev: bool(ev and ev.get("type") == "metered_start"), 300)
        self._advance(demo, 4)
        st = await self._wait_terminal(demo)
        if st == "DELIVERED":
            self._advance(demo, 5)
            await asyncio.sleep(1.5)
            self._advance(demo, 6)
        await asyncio.sleep(1)
        await self._done(st)


# ---------- live sponsor proxies
_stripe_cache: dict[str, Any] = {"at": 0.0, "limit": 0, "data": None}
_box_cache: dict[str, Any] = {"at": 0.0, "data": None}


async def stripe_payments(limit: int = 12) -> dict:
    key = os.environ.get("STRIPE_SECRET_KEY", "")
    if not key:
        return {"payments": [], "error": "no STRIPE_SECRET_KEY", "fetched_at": _now_iso()}
    now = time.monotonic()
    if _stripe_cache["data"] is not None and now - _stripe_cache["at"] < 2 and _stripe_cache["limit"] >= limit:
        return _stripe_cache["data"]
    acct = key.split("_")[2][:14] if key.count("_") >= 2 else None
    try:
        async with httpx.AsyncClient(timeout=6) as c:
            r = await c.get("https://api.stripe.com/v1/payment_intents", params={"limit": limit}, auth=(key, ""))
            j = r.json()
    except Exception as e:
        return {"payments": [], "error": f"stripe unreachable: {e}", "fetched_at": _now_iso()}
    pays = []
    for p in j.get("data", []):
        md = p.get("metadata") or {}
        pays.append({"id": p.get("id"), "amount_cents": p.get("amount"), "currency": p.get("currency"), "status": p.get("status"),
                     "intent": md.get("mpp_intent"), "created": datetime.fromtimestamp(p.get("created", 0), tz=timezone.utc).isoformat(),
                     "description": p.get("description"), "url": f"https://dashboard.stripe.com/test/payments/{p.get('id')}"})
    out = {"payments": pays, "account": os.environ.get("STRIPE_ACCOUNT_ID", "acct_1URuY0GhDL5moMEd"), "livemode": False, "fetched_at": _now_iso()}
    _stripe_cache.update({"at": now, "limit": limit, "data": out})
    return out


def _instabox_ls() -> list[dict]:
    env = {**os.environ, "PATH": f"{INSTABOX}:{NODE22}:" + os.environ.get("PATH", "")}
    r = subprocess.run(["instabox", "ls", "--json"], capture_output=True, text=True, timeout=10, env=env)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:200] or "instabox ls failed")
    return json.loads(r.stdout)


async def instabox_boxes() -> dict:
    now = time.monotonic()
    if _box_cache["data"] is not None and now - _box_cache["at"] < 8:
        return _box_cache["data"]
    try:
        boxes_raw = await asyncio.to_thread(_instabox_ls)
        err = None
    except Exception as e:
        boxes_raw, err = [], str(e)
    urls = config.operator_urls()
    pub = {"orbital-foundry": os.environ.get("INSTABOX_URL_PHISAT"), "lumen-relay": os.environ.get("INSTABOX_URL_EDRS"), "northstar-relay": os.environ.get("INSTABOX_URL_STARLINK")}

    async def op_status(operator_id: str) -> dict | None:
        base = urls.get(operator_id)
        if not base:
            return None
        try:
            async with httpx.AsyncClient(timeout=4) as c:
                r = await c.get(f"{base}/status")
                if r.status_code != 200:
                    return {"online": False}
                j = r.json()
                return {"online": True, "sim_t": j.get("sim_t"), "grants": {k: v for k, v in (j.get("grants") or {}).items() if k != "list"},
                        "power_wh": j.get("power_wh"), "capacity": j.get("capacity"), "rail": j.get("rail") or "stripe"}
        except Exception:
            return {"online": False}

    out = []
    for b in boxes_raw:
        name = b.get("name")
        node_id, operator_id, role = BOX_TO_NODE.get(name, (None, None, None))
        st = await op_status(operator_id) if operator_id else None
        out.append({"name": name, "id": b.get("id"), "state": b.get("state"), "template": (b.get("template") or {}).get("id"), "created": b.get("createdAt"),
                    "node_id": node_id, "operator_id": operator_id, "role": role, "public_url": pub.get(name) or urls.get(operator_id or ""), "operator": st})
    res = {"boxes": out, "fetched_at": _now_iso(), **({"error": err} if err else {})}
    _box_cache.update({"at": now, "data": res})
    return res
