"""Paths and environment for the sim."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent  # repo root
SIM_DIR = ROOT / "sim"


def env(name: str, default: str | None = None) -> str | None:
    return os.environ.get(name, default)


SCENARIO_PATH = Path(env("SCENARIO", "data/scenario.json"))
if not SCENARIO_PATH.is_absolute():
    SCENARIO_PATH = ROOT / SCENARIO_PATH
TLE_PATH = ROOT / "data" / "active.tle"
KEYS_DIR = ROOT / "keys"
SIM_PUBLIC_URL = env("SIM_PUBLIC_URL", "http://localhost:8000").rstrip("/")
BROKER_URL = env("BROKER_URL", "http://localhost:3000").rstrip("/")
# OCGP §2.10: relay downlinks are carried as metered MPP sessions through the broker (pay per 100 KB as bytes flow)
METERED_RELAY = env("METERED_RELAY", "1") == "1"
ADMIN_TOKEN = env("ADMIN_TOKEN", "judge-556677")


def operator_urls() -> dict[str, str]:
    raw = env(
        "OPERATOR_URLS",
        "orbital-foundry=http://localhost:7001,lumen-relay=http://localhost:7002,northstar-relay=http://localhost:7003",
    )
    out: dict[str, str] = {}
    for part in raw.split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip().rstrip("/")
    return out
