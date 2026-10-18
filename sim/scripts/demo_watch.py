"""Run a demo via the sim API and print step timings from the WS stream. Usage: python demo_watch.py <id>"""
import asyncio, json, sys, time, httpx, websockets

SIM = "http://localhost:8000"

async def main(demo_id: int):
    t0 = time.monotonic()
    async with websockets.connect(SIM.replace("http", "ws") + "/ws", max_size=2**22) as ws:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{SIM}/demos/{demo_id}/start")
            print(f"start demo {demo_id}: {r.status_code} {r.text[:80]}")
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=900))
            t = msg.get("type"); el = time.monotonic() - t0
            if t == "demo_started":
                print(f"[{el:6.1f}s] STARTED {msg['title']} ({msg['total']} steps, accel {msg.get('accel')})")
            elif t == "demo_step":
                print(f"[{el:6.1f}s] step {msg['step']}/{msg['total']} sim T+{int(msg.get('sim_t',0))}: {msg['title']}")
            elif t == "fast_forward":
                print(f"[{el:6.1f}s] FAST-FORWARD T+{msg['from_sim_t']}→T+{msg['to_sim_t']}")
            elif t in ("link_killed", "provider_online", "refund", "metered_start", "metered_settled", "payment", "reconcile_violation"):
                print(f"[{el:6.1f}s]   {t} {msg.get('operator_id','')} {msg.get('amount_usd', msg.get('total_usd',''))}")
            elif t == "narration" and msg.get("source") == "buyer":
                print(f"[{el:6.1f}s]   buyer: {msg.get('text','')[:110]}")
            elif t == "demo_done":
                print(f"[{el:6.1f}s] DONE {msg['status']} {json.dumps(msg['summary'])[:300]}")
                return

asyncio.run(main(int(sys.argv[1])))
