"""Scenario loading."""
import json
from pathlib import Path


def load_scenario(path: Path) -> dict:
    sc = json.loads(path.read_text())
    sc.setdefault("sim", {}).setdefault("accel", 4)
    sc["sim"].setdefault("horizon_s", 2400)
    return sc


def node_map(sc: dict) -> dict[str, dict]:
    return {n["node_id"]: n for n in sc["nodes"]}


def gs_ids(sc: dict) -> set[str]:
    return {g["gs_id"] for g in sc["ground_stations"]}
