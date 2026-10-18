"""Real SGP4 propagation of real TLEs via Skyfield, cached over the scenario horizon."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from skyfield.api import EarthSatellite, load, wgs84


def _parse_tles(path: Path) -> dict[str, tuple[str, str]]:
    out: dict[str, tuple[str, str]] = {}
    if not path.exists():
        return out
    lines = [l.rstrip("\n") for l in path.read_text().splitlines()]
    i = 0
    while i + 2 < len(lines):
        name, l1, l2 = lines[i].strip(), lines[i + 1], lines[i + 2]
        if l1.startswith("1 ") and l2.startswith("2 "):
            out[name] = (l1, l2)
            i += 3
        else:
            i += 1
    return out


# Fallback TLEs (CelesTrak 2026-10-17) so the sim works even without data/active.tle
FALLBACK = {
    "SENTINEL-2A": ("1 40697U 15028A   26290.94189698  .00000039  00000+0  31625-4 0  9997",
                    "2 40697  98.5633   4.0001 0001054  93.6034 266.5270 14.30823022591280"),
    "LANDSAT 9": ("1 49260U 21088A   26290.42881643  .00000271  00000+0  70282-4 0  9997",
                  "2 49260  98.2159 359.0446 0001331  86.7622 273.3729 14.57114868268809"),
}


class Orbits:
    def __init__(self, scenario: dict, tle_path: Path, step_s: int = 5):
        self.ts = load.timescale(builtin=True)
        self.epoch = datetime.fromisoformat(scenario["epoch_utc"].replace("Z", "+00:00")).astimezone(timezone.utc)
        self.horizon = int(scenario["sim"]["horizon_s"])
        self.step = step_s
        tles = _parse_tles(tle_path)
        self.sats: dict[str, EarthSatellite] = {}
        self.missing: list[str] = []
        for n in scenario["nodes"]:
            name = n.get("tle_name", n["node_id"])
            pair = tles.get(name) or FALLBACK.get(name)
            if pair is None:
                # try prefix match (e.g. "PHISAT 2" vs "PHISAT-2")
                cand = [k for k in tles if k.replace("-", " ").upper().startswith(name.replace("-", " ").upper())]
                pair = tles[cand[0]] if cand else None
            if pair is None:
                self.missing.append(n["node_id"])
                continue
            self.sats[n["node_id"]] = EarthSatellite(pair[0], pair[1], name, self.ts)
        self.times = np.arange(0, self.horizon + self.step, self.step, dtype=float)
        self.cache: dict[str, np.ndarray] = {}
        self._build()

    def _build(self):
        t = self.ts.utc(self.epoch.year, self.epoch.month, self.epoch.day, self.epoch.hour, self.epoch.minute,
                        self.epoch.second + self.times)
        for nid, sat in self.sats.items():
            geo = sat.at(t)
            gp = wgs84.geographic_position_of(geo)
            self.cache[nid] = np.stack([self.times, gp.latitude.degrees, gp.longitude.degrees, gp.elevation.km], axis=1)

    def at(self, node_id: str, sim_t: float) -> tuple[float, float, float] | None:
        arr = self.cache.get(node_id)
        if arr is None:
            return None
        idx = int(np.clip(round(sim_t / self.step), 0, len(arr) - 1))
        _, lat, lon, alt = arr[idx]
        return float(lat), float(lon), float(alt)

    def series(self, node_id: str, t0: float, t1: float, step: float) -> list[list[float]]:
        arr = self.cache.get(node_id)
        if arr is None:
            return []
        out = []
        t = max(0.0, t0)
        while t <= min(t1, self.horizon):
            idx = int(np.clip(round(t / self.step), 0, len(arr) - 1))
            out.append([float(t), round(float(arr[idx][1]), 4), round(float(arr[idx][2]), 4), round(float(arr[idx][3]), 1)])
            t += max(1.0, step)
        return out
