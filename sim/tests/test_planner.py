import json
from pathlib import Path

from app.planner import plan, windows_from_scenario
from app.scenario import gs_ids, node_map

ROOT = Path(__file__).resolve().parent.parent.parent
SC = json.loads((ROOT / "data" / "scenario.json").read_text())


def _req(**over):
    m = SC["mission"]
    r = {"mission_id": m["mission_id"], "source_node": m["source_node"], "payload_mb": m["payload_mb"], "op": m["op"],
         "model": m["model"], "result_mb_estimate": m["result_mb_estimate"], "deadline_sim_t": m["deadline_sim_t"],
         "budget_usd": m["budget_usd"], "now_sim_t": 0, "quotes": []}
    r.update(over)
    return r


def _run(statuses=None, offline=None, **over):
    return plan(_req(**over), windows_from_scenario(SC, statuses), node_map(SC), gs_ids(SC), offline=offline or set())


def by_strategy(plans, s):
    return [p for p in plans if p["strategy"] == s]


def test_canonical_candidates_present():
    plans = _run(offline={"STARLINK-3005"})
    assert by_strategy(plans, "own-downlink"), "own downlink candidate missing"
    assert by_strategy(plans, "raw-relay"), "raw relay candidate missing"
    assert by_strategy(plans, "compute+relay"), "compute+relay candidate missing"


def test_own_downlink_infeasible_by_deadline():
    p = by_strategy(_run(), "own-downlink")[0]
    assert not p["feasible"]
    assert any("deadline" in r for r in p["reasons"])
    assert p["delivery_sim_t"] > 1500 and p["cost_usd"] == 0


def test_raw_relay_infeasible_on_bytes():
    raw = [p for p in by_strategy(_run(offline={"STARLINK-3005"}), "raw-relay") if "EDRS-C" in p["label"]]
    assert raw
    p = raw[0]
    assert not p["feasible"]
    assert any("fits" in r for r in p["reasons"]), p["reasons"]


def test_compute_relay_feasible_and_cheap():
    plans = _run(offline={"STARLINK-3005"})
    best = plans[0]
    assert best["feasible"] and best["strategy"] == "compute+relay"
    assert "PHISAT-2" in best["label"] and "EDRS-C" in best["label"]
    assert 300 <= best["delivery_sim_t"] <= 360
    assert abs(best["cost_usd"] - 2.45) < 0.05, best["cost_usd"]
    assert best["quoted"] is False and all(l["price_estimated"] for l in best["legs"] if l["price_usd"] > 0)
    kinds = [l["kind"] for l in best["legs"]]
    assert kinds == ["transfer", "compute", "transfer", "transfer"]


def test_quotes_override_estimates():
    quotes = [{"quote_id": "q1", "node_id": "PHISAT-2", "window_id": "w_A_B_1", "price_usd": 1.90},
              {"quote_id": "q2", "node_id": "EDRS-C", "window_id": "w_C_GS_1", "price_usd": 0.55}]
    best = _run(offline={"STARLINK-3005"}, quotes=quotes)[0]
    assert best["quoted"] and abs(best["cost_usd"] - 2.45) < 1e-6
    assert {l["quote_id"] for l in best["legs"] if l["quote_id"]} == {"q1", "q2"}


def test_replan_after_kill_c_uses_provider_d():
    statuses = {"w_C_GS_1": "killed"}
    plans = _run(statuses=statuses, now_sim_t=280, committed={"node_id": "PHISAT-2", "result_mb": 0.04})
    feasible = [p for p in plans if p["feasible"]]
    assert feasible, [p["reasons"] for p in plans]
    best = feasible[0]
    assert "STARLINK-3005" in best["label"] and "GS-OREGON" in best["label"]
    assert 430 <= best["delivery_sim_t"] <= 440
    assert all(l["kind"] == "transfer" for l in best["legs"])  # no recompute


def test_replan_infeasible_when_d_offline():
    plans = _run(statuses={"w_C_GS_1": "killed"}, now_sim_t=280, committed={"node_id": "PHISAT-2", "result_mb": 0.04}, offline={"STARLINK-3005"})
    assert not any(p["feasible"] for p in plans)
    assert any("offline" in r for p in plans for r in p["reasons"])
