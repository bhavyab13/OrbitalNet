#!/usr/bin/env python3
"""OrbitalNet benchmark: does conditional cross-owner commitment (OCGP) waste less money and
complete more missions than buying each resource independently?

Three purchasing strategies run on IDENTICAL seeded worlds (same windows, prices, failure events):

  A. independent   — pay for each leg as soon as its quote is accepted, no holds, no refunds
                     (plain pay-per-request semantics, e.g. one MPP 402 per resource).
  B. ocgp          — hold every leg, pay only if all holds succeed (E1 withdrawals cost $0);
                     a paid-but-unfulfilled grant on a failed provider is refunded (E2),
                     fulfilled work is preserved, replan from the node holding the result.
  C. omniscient    — central scheduler that knows every failure and arrival in advance;
                     an upper bound that violates the independent-ownership assumption.

The world model is deliberately simple and transparent (see README.md):
  * contact windows / bandwidth / prices come from data/scenario.json with seeded jitter;
  * feasibility is decided by the real planner (sim/app/planner.py), unchanged;
  * E2 "link killed" events happen at an absolute sim time (identical for every strategy);
  * E1 "provider withdraws capacity" is an absolute time interval during which a hold or
    purchase from that provider fails;
  * a late provider (STARLINK-3005) may come online at an absolute time.

Usage: python bench/run_bench.py --n 100 --seed 1
"""
from __future__ import annotations

import argparse
import copy
import csv
import json
import random
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "sim"))
from app.planner import WindowView, plan as planner_plan  # noqa: E402

NEGOTIATION_LATENCY_S = 5.0   # quote/hold/commit round trip, same for every strategy
LATE_PROVIDER = "STARLINK-3005"
RELAY_WINDOWS = ("w_C_GS_1", "w_D_GS_1")   # downlink windows an E2 kill can target
RELAY_OPERATORS = ("lumen-relay", "northstar-relay")


# ----------------------------------------------------------------------------- world
@dataclass
class World:
    seed: int
    deadline: float
    budget: float
    payload_mb: float
    windows: list[WindowView]
    nodes: dict[str, dict]
    gs: set[str]
    late_online_at: float | None            # None = never
    kill: tuple[str, float] | None          # (window_id, t_kill)
    withdraw: tuple[str, float, float] | None  # (operator_id, t0, t1)
    mission: dict

    def window(self, wid: str) -> WindowView:
        return next(w for w in self.windows if w.window_id == wid)

    def offline_at(self, t: float) -> set[str]:
        return set() if (self.late_online_at is not None and t >= self.late_online_at) else {LATE_PROVIDER}

    def killed_at(self, t: float) -> set[str]:
        return {self.kill[0]} if self.kill and t >= self.kill[1] else set()

    def withdrawn(self, operator_id: str, t: float) -> bool:
        return bool(self.withdraw) and self.withdraw[0] == operator_id and self.withdraw[1] <= t <= self.withdraw[2]


def make_world(sc: dict, seed: int, p_fail: float, p_withdraw: float) -> World:
    rng = random.Random(seed)
    nodes = {n["node_id"]: copy.deepcopy(n) for n in sc["nodes"]}
    for n in nodes.values():
        cap = n.get("capability") or {}
        if cap.get("type") == "relay":
            f = rng.uniform(0.7, 1.6)
            cap["price_per_mb"] = cap.get("price_per_mb", 0.02) * f
            cap["price_min_usd"] = cap.get("price_min_usd", 0.5) * f
        elif cap.get("type") == "compute":
            cap["price_base_usd"] = cap.get("price_base_usd", 1.5) * rng.uniform(0.8, 1.3)
    windows = []
    for w in sc["windows"]:
        start = max(0.0, w["start"] + rng.uniform(-30, 30))
        dur = (w["end"] - w["start"]) * rng.uniform(0.7, 1.3)
        wv = WindowView(w["window_id"], w["from"], w["to"], start, start + dur, float(w["bandwidth_mbps"]), w.get("kind", "crosslink"))
        wv.remaining_mb = wv.capacity_mb
        windows.append(wv)
    late = rng.uniform(200, 450) if rng.random() < 0.5 else None
    kill = None
    if rng.random() < p_fail:
        wid = rng.choice(RELAY_WINDOWS)
        kill = (wid, rng.uniform(0.0, 1.0) * next(w.start for w in windows if w.window_id == wid))
    withdraw = None
    if rng.random() < p_withdraw:
        t0 = rng.uniform(0, 200)
        withdraw = (rng.choice(RELAY_OPERATORS), t0, t0 + rng.uniform(60, 200))
    m = sc["mission"]
    mission = {**m, "deadline_sim_t": rng.uniform(480, 900), "budget_usd": rng.uniform(3.0, 8.0), "payload_mb": rng.uniform(120, 260)}
    return World(seed, mission["deadline_sim_t"], mission["budget_usd"], mission["payload_mb"], windows, nodes,
                 {g["gs_id"] for g in sc["ground_stations"]}, late, kill, withdraw, mission)


# ----------------------------------------------------------------------------- economics
@dataclass
class Grant:
    operator_id: str
    window_id: str
    price: float
    fulfilled: bool = False
    refunded: bool = False
    leg_kind: str = "transfer"


@dataclass
class Outcome:
    strategy: str
    completed: bool
    delivery_t: float | None
    paid: float
    wasted: float
    stranded: int
    rejected_ops: int
    replans: int
    replan_latency: list[float] = field(default_factory=list)
    waited_for_provider: bool = False


def feasible_plans(world: World, now: float, committed: dict | None, budget_left: float, exclude: set[str]) -> list[dict]:
    req = {"mission_id": "bench", "source_node": world.mission["source_node"], "payload_mb": world.payload_mb,
           "op": world.mission["op"], "model": world.mission["model"], "result_mb_estimate": world.mission["result_mb_estimate"],
           "deadline_sim_t": world.deadline, "budget_usd": budget_left, "now_sim_t": now,
           "exclude_windows": sorted(exclude), "committed": committed}
    wins = copy.deepcopy(world.windows)
    for w in wins:
        if w.window_id in world.killed_at(now):
            w.status = "killed"
    plans = planner_plan(req, wins, world.nodes, world.gs, offline=world.offline_at(now))
    ok = [p for p in plans if p["feasible"]]
    ok.sort(key=lambda p: (p["delivery_sim_t"], p["cost_usd"]))   # same rule as the buyer agent
    return ok


def priced_legs(p: dict) -> list[dict]:
    return [l for l in p["legs"] if l["price_usd"] > 1e-9]


def execute(world: World, p: dict, commit_t: float, grants: dict[tuple, Grant], out: Outcome, refunds: bool):
    """Run a committed plan forward. Returns (delivered_t | None, committed_result | None, failure_t | None)."""
    committed = None
    for leg in p["legs"]:
        wid = leg["window_id"]
        if world.kill and world.kill[0] == wid and world.kill[1] < leg["end"] and leg["kind"] == "transfer":
            # the window dies before this transfer completes -> everything not yet fulfilled is at risk
            t_fail = max(world.kill[1], commit_t)
            for g in grants.values():
                if g.fulfilled:
                    continue
                if g.window_id == wid and refunds:
                    g.refunded = True
                elif g.window_id == wid and not refunds:
                    out.rejected_ops += 1   # an agent without a world assertion tries the dead link and is refused
            return None, committed, t_fail
        key = (leg.get("operator_id"), wid, leg["kind"])
        if key in grants:
            grants[key].fulfilled = True
        if leg["kind"] == "compute":
            committed = {"node_id": leg["node"], "result_mb": world.mission["result_mb_estimate"]}
    return p["delivery_sim_t"], committed, None


def run_strategy(world: World, strategy: str) -> Outcome:
    out = Outcome(strategy, False, None, 0.0, 0.0, 0, 0, 0)
    grants: dict[tuple, Grant] = {}
    now, committed, exclude = 0.0, None, set()
    last_failure_t: float | None = None

    def budget_left() -> float:
        paid = sum(g.price for g in grants.values() if not g.refunded)
        return world.budget - paid

    for _ in range(8):
        plans = feasible_plans(world, now, committed, budget_left(), exclude)
        if not plans:
            # nothing feasible now: wait for the late provider if it is still to come (both A and B do this)
            if world.late_online_at is not None and now < world.late_online_at < world.deadline:
                now = world.late_online_at
                out.waited_for_provider = True
                continue
            break
        p = plans[0]
        commit_t = now + NEGOTIATION_LATENCY_S

        # ---- purchase phase
        legs = priced_legs(p)
        need = [l for l in legs if (l.get("operator_id"), l["window_id"], l["kind"]) not in grants or grants[(l.get("operator_id"), l["window_id"], l["kind"])].refunded]
        if strategy == "independent":
            bought_all = True
            for l in need:
                if world.withdrawn(l["operator_id"], now):
                    bought_all = False
                    break
                grants[(l["operator_id"], l["window_id"], l["kind"])] = Grant(l["operator_id"], l["window_id"], l["price_usd"], leg_kind=l["kind"])
            if not bought_all:
                now = commit_t
                out.replans += 1
                # money already spent on earlier legs stays spent; try again (maybe another plan / later time)
                continue
        else:  # ocgp: holds first, pay only if every hold succeeds
            if any(world.withdrawn(l["operator_id"], now) for l in need):
                now = commit_t
                out.replans += 1
                continue
            for l in need:
                grants[(l["operator_id"], l["window_id"], l["kind"])] = Grant(l["operator_id"], l["window_id"], l["price_usd"], leg_kind=l["kind"])
        if last_failure_t is not None:
            out.replan_latency.append(commit_t - last_failure_t)
            last_failure_t = None

        # ---- execution phase
        delivered, committed_new, t_fail = execute(world, p, commit_t, grants, out, refunds=(strategy == "ocgp"))
        if committed_new:
            committed = committed_new
        if delivered is not None:
            out.completed, out.delivery_t = delivered <= world.deadline, delivered
            break
        exclude |= world.killed_at(t_fail)
        now = t_fail
        last_failure_t = t_fail
        out.replans += 1

    out.paid = round(sum(g.price for g in grants.values() if not g.refunded), 4)
    waste = [g for g in grants.values() if not g.fulfilled and not g.refunded]
    out.wasted = round(sum(g.price for g in waste), 4)
    out.stranded = len(waste)
    return out


def _executable(world: World, p: dict, now: float) -> bool:
    """A plan is executable with foreknowledge if no leg uses the window that will be killed, every leg touching the
    late provider starts after it is online, and the priced legs can be bought at some time t (now, or right after
    the withdrawal interval) with t + negotiation latency <= first leg start."""
    if world.kill and any(l["window_id"] == world.kill[0] for l in p["legs"]):
        return False
    touches_late = [l for l in p["legs"] if LATE_PROVIDER in (l.get("from"), l.get("to"), l.get("node"))]
    if touches_late and (world.late_online_at is None or any(l["start"] < world.late_online_at - 1e-9 for l in touches_late)):
        return False
    first_start = min(l["start"] for l in p["legs"])
    buy_times = [now] + ([world.withdraw[2] + 1e-6] if world.withdraw else [])
    # same convention as A/B: a plan computed at time t executes from t; the negotiation latency is charged to the
    # replan clock, not to leg feasibility
    return any(t <= first_start + 1e-9 and not any(world.withdrawn(l["operator_id"], t) for l in priced_legs(p))
               for t in buy_times)


def run_omniscient(world: World) -> Outcome:
    """Central scheduler that knows the kill, the withdrawal and the late arrival in advance (upper bound; it
    violates the independent-ownership assumption). Candidate executions:
      (1) one plan from t=0 with every provider present, filtered by _executable;
      (2) if a provider arrives late: run compute first (cheapest executable compute leg from t=0), then at the
          arrival time plan the delivery of the small result with the newcomer available.
    Picks the cheapest executable candidate."""
    out = Outcome("omniscient", False, None, 0.0, 0.0, 0, 0, 0)
    base = {"mission_id": "bench", "source_node": world.mission["source_node"], "payload_mb": world.payload_mb,
            "op": world.mission["op"], "model": world.mission["model"], "result_mb_estimate": world.mission["result_mb_estimate"],
            "deadline_sim_t": world.deadline, "budget_usd": world.budget, "exclude_windows": [], "committed": None}
    cands: list[tuple[float, float]] = []   # (cost, delivery)
    plans0 = planner_plan({**base, "now_sim_t": 0.0}, copy.deepcopy(world.windows), world.nodes, world.gs, offline=set())
    for p in plans0:
        if p["feasible"] and _executable(world, p, 0.0):
            cands.append((p["cost_usd"], p["delivery_sim_t"]))
    if world.late_online_at is not None:
        late = world.late_online_at
        # cheapest compute prefix that completes before the arrival and does not touch the newcomer
        prefixes = []
        for p in plans0:
            legs = p["legs"]
            ci = next((i for i, l in enumerate(legs) if l["kind"] == "compute"), None)
            if ci is None or legs[ci]["end"] > late:
                continue
            prefix = legs[: ci + 1]
            if any(LATE_PROVIDER in (l.get("from"), l.get("to"), l.get("node")) for l in prefix):
                continue
            q = {**p, "legs": prefix}
            if _executable(world, q, 0.0) and all(l["end"] <= late for l in prefix):
                prefixes.append((sum(l["price_usd"] for l in prefix), legs[ci]["node"]))
        if prefixes:
            cp, node = min(prefixes)
            committed = {"node_id": node, "result_mb": world.mission["result_mb_estimate"]}
            for p in planner_plan({**base, "now_sim_t": late, "committed": committed, "budget_usd": world.budget - cp},
                                  copy.deepcopy(world.windows), world.nodes, world.gs, offline=set()):
                if p["feasible"] and _executable(world, p, late):
                    cands.append((cp + p["cost_usd"], p["delivery_sim_t"]))
    if cands:
        cost, dt = min(cands)
        out.completed, out.delivery_t, out.paid = True, dt, round(cost, 4)
    return out


# ----------------------------------------------------------------------------- stats
def bootstrap_ci(x: np.ndarray, n: int = 2000, seed: int = 0) -> tuple[float, float]:
    if len(x) == 0:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    means = [rng.choice(x, size=len(x), replace=True).mean() for _ in range(n)]
    return (float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default=str(ROOT / "bench"))
    args = ap.parse_args()
    sc = json.loads((ROOT / "data" / "scenario.json").read_text())
    t0 = time.time()
    rows = []
    for p_fail in (0.0, 0.2, 0.4):
        for p_withdraw in (0.0, 0.2):
            for i in range(args.n):
                seed = args.seed * 1_000_003 + int(p_fail * 100) * 10_007 + int(p_withdraw * 100) * 101 + i
                world = make_world(sc, seed, p_fail, p_withdraw)
                for o in (run_strategy(world, "independent"), run_strategy(world, "ocgp"), run_omniscient(world)):
                    rows.append({"p_fail": p_fail, "p_withdraw": p_withdraw, "mission": i, "seed": seed, "strategy": o.strategy,
                                 "completed": int(o.completed), "delivery_t": o.delivery_t, "paid": o.paid, "wasted": o.wasted,
                                 "stranded": o.stranded, "rejected_ops": o.rejected_ops, "replans": o.replans,
                                 "replan_latency": (float(np.mean(o.replan_latency)) if o.replan_latency else None),
                                 "late_provider": world.late_online_at, "kill": world.kill, "withdraw": world.withdraw})
    elapsed = time.time() - t0
    outdir = Path(args.out); outdir.mkdir(exist_ok=True)
    with open(outdir / "results.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)

    # ---- summary
    summary = []
    print(f"\nOrbitalNet benchmark — n={args.n} missions per cell, seed={args.seed}, {elapsed:.1f}s\n")
    print("| p_fail | p_withdraw | strategy | completion | wasted $/mission | wasted % of spend | stranded /100 missions | rejected ops /100 missions | replan latency s |")
    print("|---|---|---|---|---|---|---|---|---|")
    for p_fail in (0.0, 0.2, 0.4):
        for p_withdraw in (0.0, 0.2):
            cell = {}
            for s in ("independent", "ocgp", "omniscient"):
                r = [x for x in rows if x["p_fail"] == p_fail and x["p_withdraw"] == p_withdraw and x["strategy"] == s]
                comp = np.array([x["completed"] for x in r], float)
                wasted = np.array([x["wasted"] for x in r], float)
                lat = [x["replan_latency"] for x in r if x["replan_latency"] is not None]
                paid_total = float(sum(x["paid"] for x in r)); wasted_total = float(sum(x["wasted"] for x in r))
                per100 = 100.0 / max(len(r), 1)
                cell[s] = {"completion": comp.mean(), "completion_ci": bootstrap_ci(comp), "wasted": wasted.mean(),
                           "wasted_ci": bootstrap_ci(wasted),
                           "wasted_share": (wasted_total / paid_total) if paid_total > 0 else 0.0,
                           "stranded": float(np.mean([x["stranded"] for x in r])),
                           "stranded_per100": float(sum(x["stranded"] for x in r)) * per100,
                           "rejected_ops": int(sum(x["rejected_ops"] for x in r)),
                           "rejected_ops_per100": float(sum(x["rejected_ops"] for x in r)) * per100,
                           "replan_latency": (float(np.mean(lat)) if lat else None), "paid": float(np.mean([x["paid"] for x in r])),
                           "paid_total": paid_total, "wasted_total": wasted_total}
                c = cell[s]
                print(f"| {p_fail} | {p_withdraw} | {s} | {c['completion']*100:.0f}% [{c['completion_ci'][0]*100:.0f}–{c['completion_ci'][1]*100:.0f}] "
                      f"| ${c['wasted']:.2f} [{c['wasted_ci'][0]:.2f}–{c['wasted_ci'][1]:.2f}] | {c['wasted_share']*100:.1f}% | {c['stranded_per100']:.0f} | {c['rejected_ops_per100']:.0f} "
                      f"| {('%.0f' % c['replan_latency']) if c['replan_latency'] is not None else '—'} |")
            # paired B-vs-A
            a = {x["mission"]: x for x in rows if x["p_fail"] == p_fail and x["p_withdraw"] == p_withdraw and x["strategy"] == "independent"}
            b = {x["mission"]: x for x in rows if x["p_fail"] == p_fail and x["p_withdraw"] == p_withdraw and x["strategy"] == "ocgp"}
            d_w = np.array([a[i]["wasted"] - b[i]["wasted"] for i in a], float)
            d_c = np.array([b[i]["completed"] - a[i]["completed"] for i in a], float)
            cell["paired_B_minus_A"] = {"wasted_saved": d_w.mean(), "wasted_saved_ci": bootstrap_ci(d_w),
                                        "completion_gain": d_c.mean(), "completion_gain_ci": bootstrap_ci(d_c),
                                        "completion_gap_to_omniscient": cell["omniscient"]["completion"] - cell["ocgp"]["completion"]}
            summary.append({"p_fail": p_fail, "p_withdraw": p_withdraw, **cell})
    print("\nPaired differences (OCGP − independent), 95% bootstrap CI:")
    for c in summary:
        pb = c["paired_B_minus_A"]
        print(f"  p_fail={c['p_fail']} p_withdraw={c['p_withdraw']}: wasted spend saved ${pb['wasted_saved']:.2f}/mission "
              f"[{pb['wasted_saved_ci'][0]:.2f}, {pb['wasted_saved_ci'][1]:.2f}] "
              f"(independent wastes {c['independent']['wasted_share']*100:.1f}% of spend, OCGP {c['ocgp']['wasted_share']*100:.1f}%; "
              f"stranded /100: {c['independent']['stranded_per100']:.0f} vs {c['ocgp']['stranded_per100']:.0f}; "
              f"rejected ops /100: {c['independent']['rejected_ops_per100']:.0f} vs {c['ocgp']['rejected_ops_per100']:.0f}); "
              f"completion +{pb['completion_gain']*100:.0f} pts "
              f"[{pb['completion_gain_ci'][0]*100:.0f}, {pb['completion_gain_ci'][1]*100:.0f}]; gap to omniscient {pb['completion_gap_to_omniscient']*100:.0f} pts")
    (outdir / "results.json").write_text(json.dumps({"n": args.n, "seed": args.seed, "elapsed_s": elapsed, "cells": summary}, indent=2, default=float))
    chart(summary, outdir / "results.png", args.n)
    print(f"\nwrote {outdir/'results.csv'}, {outdir/'results.json'}, {outdir/'results.png'}")


def chart(summary: list[dict], path: Path, n: int):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    bg, fg, dim, grid = "#0b0f14", "#e6edf3", "#9aa4b2", "#243040"
    colors = {"independent": "#6b7684", "ocgp": "#4fd1ff", "omniscient": "#c9d1d9"}
    labels = {"independent": "A · independent purchase", "ocgp": "B · OCGP conditional commit", "omniscient": "C · omniscient (bound)"}
    plt.rcParams.update({"font.size": 13})
    fig, axes = plt.subplots(1, 3, figsize=(24, 7.6), facecolor=bg)
    xs = np.arange(len(summary))
    ticks = [f"fail {c['p_fail']:.0%}\nw/draw {c['p_withdraw']:.0%}" for c in summary]

    def style(ax, title):
        ax.set_facecolor(bg)
        ax.set_xticks(xs); ax.set_xticklabels(ticks, color=fg, fontsize=10); ax.set_xlim(-0.6, len(summary) - 0.4)
        ax.set_title(title, color=fg, fontsize=16, pad=14, loc="left")
        ax.tick_params(colors=fg, labelsize=12); ax.spines[:].set_color(grid)
        ax.yaxis.grid(True, color=grid, linewidth=0.6); ax.set_axisbelow(True)

    # (a) completion with CI — three strategies
    ax = axes[0]; width = 0.26
    style(ax, "Missions delivered before deadline")
    for k, s in enumerate(("independent", "ocgp", "omniscient")):
        vals = np.array([c[s]["completion"] for c in summary]); ci = np.array([c[s]["completion_ci"] for c in summary])
        err = np.vstack([vals - ci[:, 0], ci[:, 1] - vals]).clip(min=0)
        ax.bar(xs + (k - 1) * width, vals, width, color=colors[s], label=labels[s], yerr=err, ecolor=fg, capsize=3, linewidth=0)
    # one label per cell when all three agree, else label each bar
    for i, c in enumerate(summary):
        vals = [c[s]["completion"] for s in ("independent", "ocgp", "omniscient")]
        if max(vals) - min(vals) < 0.02:
            ax.text(xs[i], max(vals) + 0.035, f"{vals[1]:.0%}", ha="center", va="bottom", color=fg, fontsize=12)
        else:
            for k, v in enumerate(vals):
                ax.text(xs[i] + (k - 1) * width, v + 0.035, f"{v:.0%}", ha="center", va="bottom", color=fg, fontsize=8.5)
    ax.set_ylim(0, 1.18); ax.set_yticks([0, .25, .5, .75, 1]); ax.set_yticklabels(["0", "25%", "50%", "75%", "100%"], color=fg)
    ax.legend(loc="lower left", facecolor=bg, edgecolor=grid, labelcolor=fg, fontsize=11)

    # (b) wasted spend as % of total spend — A vs B (C is 0 by construction)
    ax = axes[1]; width = 0.36
    style(ax, "Money paid for work never performed (% of total spend)")
    for k, s in enumerate(("independent", "ocgp")):
        vals = np.array([c[s]["wasted_share"] * 100 for c in summary])
        ax.bar(xs + (k - 0.5) * width, vals, width, color=colors[s], label=labels[s], linewidth=0)
        for x, v in zip(xs + (k - 0.5) * width, vals):
            ax.text(x, v + 0.25, f"{v:.1f}%", ha="center", va="bottom", color=fg if s == "ocgp" else dim, fontsize=11)
    ymax = max(1.0, max(c["independent"]["wasted_share"] * 100 for c in summary) * 1.3)
    ax.set_ylim(0, ymax); ax.set_ylabel("% of all money spent", color=dim, fontsize=12)
    ax.text(0.99, 0.97, "C · omniscient = 0% (bound)", transform=ax.transAxes, color=dim, fontsize=11, va="top", ha="right")
    ax.legend(loc="upper left", facecolor=bg, edgecolor=grid, labelcolor=fg, fontsize=11)

    # (c) stranded reservations + policy-rejected operations per 100 missions — A vs B, grouped
    ax = axes[2]; width = 0.2
    style(ax, "Stranded grants · attempts on dead links (per 100 missions)")
    series = [("independent", "stranded_per100", "A · stranded grants", colors["independent"], "//"),
              ("independent", "rejected_ops_per100", "A · attempts on dead links", "#8d97a5", ""),
              ("ocgp", "stranded_per100", "B · stranded grants", colors["ocgp"], "//"),
              ("ocgp", "rejected_ops_per100", "B · attempts on dead links", "#9fe3ff", "")]
    for k, (s, key, lab, col, hatch) in enumerate(series):
        vals = np.array([c[s][key] for c in summary])
        ax.bar(xs + (k - 1.5) * width, vals, width, color=col, label=lab, linewidth=0, hatch=hatch, edgecolor=bg)
        for x, v in zip(xs + (k - 1.5) * width, vals):
            ax.text(x, v + 0.4, f"{v:.0f}", ha="center", va="bottom", color=fg if s == "ocgp" else dim, fontsize=10)
    ymax = max(5.0, max(max(c["independent"]["stranded_per100"], c["independent"]["rejected_ops_per100"]) for c in summary) * 1.3)
    ax.set_ylim(0, ymax); ax.set_ylabel("count per 100 missions", color=dim, fontsize=12)
    ax.legend(loc="upper left", facecolor=bg, edgecolor=grid, labelcolor=fg, fontsize=11)

    fig.suptitle(f"OCGP vs. independent purchasing — {n} seeded missions per cell, 95% bootstrap CIs (preliminary simulation, modeled windows). "
                 f"x-axis: probability a relay link dies (fail) / a provider withdraws before commit (w/draw)",
                 color=dim, fontsize=13, x=0.01, ha="left", y=0.995)
    fig.text(0.01, 0.945, "Same completion as an omniscient scheduler; zero money stranded; zero attempts on dead links.",
             color=fg, fontsize=18, ha="left", va="top", fontweight="bold")
    fig.tight_layout(rect=(0, 0, 1, 0.89), w_pad=3.0)
    fig.savefig(path, dpi=130, facecolor=bg)


if __name__ == "__main__":
    main()
