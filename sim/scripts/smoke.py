#!/usr/bin/env python3
"""Smoke test against a running sim: /state, /plan (no quotes), /assert. Usage: python scripts/smoke.py [http://localhost:8000]"""
import json
import sys
import urllib.request

base = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000").rstrip("/")


def get(p):
    return json.load(urllib.request.urlopen(base + p))


def post(p, body):
    req = urllib.request.Request(base + p, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req))


s = get("/state")
print(f"scenario {s['scenario_id']}  sim_t={s['sim_t']}  accel={s['real_accel']}  paused={s['paused']}")
for n in s["nodes"]:
    print(f"  {n['node_id']:<14} {n['role']:<8} online={n['online']!s:<5} lat={n['lat']:.2f} lon={n['lon']:.2f} alt={n['alt_km']:.0f} km")
print("windows:")
for w in s["windows"]:
    print(f"  {w['window_id']:<12} {w['from']:>13} → {w['to']:<16} [{w['start']:>5}-{w['end']:>5}] {w['bandwidth_mbps']:>4} Mbps {w['status']:<7} cap {w['remaining_mb']} MB")
a = get("/assert?window_id=w_A_B_1")
print(f"world assertion: kid={a['kid']} sim_t={a['sim_t']} open={a['open']} sig={a['sig'][:16]}…")
plans = post("/plan", {"now_sim_t": 0})["plans"]
print(f"\n{'':3}{'plan':<58}{'delivery':>9}{'cost':>8}  reasons")
for p in plans:
    print(f"{'OK' if p['feasible'] else 'NO':<3}{p['label']:<58}{'T+%ds' % p['delivery_sim_t']:>9}{'$%.2f' % p['cost_usd']:>8}  {'; '.join(p['reasons'][:2])}")
