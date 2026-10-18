"""Time-expanded path planner (pure). See docs/API.md §1 /plan and docs/PROTOCOL.md §3.

Pricing convention (matches operator quotes/grants):
  * compute node: one quote keyed (compute_node, ingest window id) -> price covers ingest + inference.
    The price is attached to the `compute` leg, whose `window_id` is the ingest window.
  * relay node: one quote keyed (relay_node, downlink window id) -> price for carrying the bytes.
    Attached to the downlink `transfer` leg. Crosslinks into a relay are free (the relay charges on delivery).
  * own-operator legs (source satellite -> ground station) are free.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

EPS = 1e-6


@dataclass
class WindowView:
    window_id: str
    frm: str
    to: str
    start: float
    end: float
    bandwidth_mbps: float
    kind: str
    status: str = "future"  # future|open|closed|killed
    remaining_mb: float | None = None

    @property
    def capacity_mb(self) -> float:
        return self.bandwidth_mbps * (self.end - self.start) / 8.0


@dataclass
class Leg:
    kind: str  # transfer|compute
    window_id: str
    start: float
    end: float
    bytes_mb: float
    duration_s: float
    price_usd: float = 0.0
    quote_id: str | None = None
    price_estimated: bool = False
    frm: str | None = None
    to: str | None = None
    node: str | None = None
    op: str | None = None
    model: str | None = None
    operator_id: str | None = None

    def to_dict(self) -> dict:
        d = {
            "kind": self.kind, "window_id": self.window_id, "start": round(self.start, 3), "end": round(self.end, 3),
            "bytes_mb": round(self.bytes_mb, 4), "duration_s": round(self.duration_s, 3),
            "price_usd": round(self.price_usd, 4), "quote_id": self.quote_id, "price_estimated": self.price_estimated,
            "operator_id": self.operator_id,
        }
        if self.kind == "transfer":
            d.update({"from": self.frm, "to": self.to})
        else:
            d.update({"node": self.node, "op": self.op, "model": self.model})
        return d


@dataclass
class Plan:
    plan_id: str
    label: str
    strategy: str  # own-downlink|raw-relay|compute+relay
    legs: list[Leg]
    delivery_sim_t: float
    cost_usd: float
    feasible: bool
    quoted: bool
    reasons: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    fidelity: str = "full"      # full | low
    tradeoff: str = ""          # short human summary relative to the other feasible plans
    payload_mb: float = 0.0     # bytes leaving the source node (modeled)

    def to_dict(self) -> dict:
        return {
            "plan_id": self.plan_id, "label": self.label, "strategy": self.strategy,
            "legs": [l.to_dict() for l in self.legs],
            "delivery_sim_t": round(self.delivery_sim_t, 2), "cost_usd": round(self.cost_usd, 4),
            "feasible": self.feasible, "quoted": self.quoted, "reasons": self.reasons, "notes": self.notes,
            "fidelity": self.fidelity, "tradeoff": self.tradeoff, "payload_mb": round(self.payload_mb, 3),
        }


def _cap(node: dict) -> dict | None:
    return node.get("capability")


def _estimate_price(node: dict, mb: float, compute_s: float | None) -> float:
    cap = _cap(node) or {}
    if cap.get("type") == "compute":
        return float(cap.get("price_base_usd", 0)) + float(cap.get("price_per_compute_s", 0)) * float(compute_s or 0)
    if cap.get("type") == "relay":
        return max(float(cap.get("price_min_usd", 0)), float(cap.get("price_per_mb", 0)) * mb)
    return 0.0


def _routes(start: str, windows: list[WindowView], gs: set[str], max_hops: int = 4):
    """Enumerate structural routes (window sequences) from start to any ground station, no node revisits."""
    out: list[list[WindowView]] = []
    by_from: dict[str, list[WindowView]] = {}
    for w in windows:
        by_from.setdefault(w.frm, []).append(w)

    def dfs(node: str, path: list[WindowView], visited: set[str]):
        if node in gs:
            out.append(list(path))
            return
        if len(path) >= max_hops:
            return
        for w in sorted(by_from.get(node, []), key=lambda x: x.start):
            if w.to in visited:
                continue
            # time-ordering prune: a window that ends before the previous one starts can never be used after it
            if path and w.end < path[-1].start:
                continue
            path.append(w)
            visited.add(w.to)
            dfs(w.to, path, visited)
            visited.discard(w.to)
            path.pop()

    dfs(start, [], {start})
    return out


def plan(req: dict, windows: list[WindowView], nodes: dict[str, dict], gs: set[str], offline: set[str] | None = None) -> list[dict]:
    offline = offline or set()
    now = float(req.get("now_sim_t", 0))
    deadline = float(req["deadline_sim_t"])
    budget = float(req.get("budget_usd", 0))
    exclude = set(req.get("exclude_windows") or [])
    committed = req.get("committed")
    op = req.get("op")
    model = req.get("model")
    result_mb = float(req.get("result_mb_estimate") or 0.05)
    # Quotes are keyed by (node, window) and matched on the quoted units too, so a 40 MB crop and a
    # 180 MB raw relay over the same window keep their own prices.
    quotes_by_key: dict = {}
    for q in req.get("quotes") or []:
        quotes_by_key.setdefault((q.get("node_id"), q.get("window_id")), []).append(q)

    def find_quote(node_id, window_id, mb=None, compute_s=None):
        cands = quotes_by_key.get((node_id, window_id)) or []
        if not cands:
            return None
        def ok(q):
            u = q.get("units") or {}
            if mb is not None and u.get("mb") is not None and abs(float(u["mb"]) - float(mb)) > 0.1 * max(float(mb), 1e-6) + 0.01:
                return False
            if compute_s is not None and u.get("compute_s") is not None and abs(float(u["compute_s"]) - float(compute_s)) > 0.25 * max(float(compute_s), 1.0):
                return False
            return True
        matched = [q for q in cands if ok(q)]
        return matched[0] if matched else None

    degraded = req.get("degraded") or None
    required_fidelity = str(req.get("required_fidelity") or "any")
    if committed:
        start_node = committed["node_id"]
        payload0 = float(committed.get("result_mb", result_mb))
        need_compute = False
        committed_fidelity = str(committed.get("fidelity") or "full")
    else:
        start_node = req["source_node"]
        payload0 = float(req["payload_mb"])
        need_compute = bool(op)
        committed_fidelity = "full"

    usable = [w for w in windows if w.window_id not in exclude]
    plans: list[Plan] = []

    for route in _routes(start_node, usable, gs):
        # Decide compute variants: no compute, or compute at the first compute-capable node reached before the downlink.
        compute_opts: list[str | None] = [None]
        if need_compute:
            for w in route[:-1]:
                n = nodes.get(w.to)
                if n and (_cap(n) or {}).get("type") == "compute" and model in (_cap(n).get("models") or [model]):
                    compute_opts.append(w.to)
        variants: list[tuple[str | None, str, float]] = [(c, committed_fidelity, payload0) for c in compute_opts]
        # Degraded product: a downsampled crop of the raw scene, delivered without on-orbit analysis.
        # Only meaningful for raw routes that leave the source (no compute), before anything is committed.
        if degraded and not committed and len(route) > 1:
            variants.append((None, "low", float(degraded.get("payload_mb", payload0))))
        for compute_at, fidelity, payload_start in variants:
            legs: list[Leg] = []
            reasons: list[str] = []
            notes: list[str] = []
            t = now
            payload = payload_start
            quoted = True
            cost = 0.0
            if fidelity == "low":
                notes.append(f"{degraded.get('label', 'degraded product')}: {degraded.get('note', '')}".strip(": "))
                if required_fidelity == "full":
                    reasons.append("mission requires full fidelity")
            elif need_compute and compute_at is None and not committed:
                # raw relay / own downlink of the full scene: result produced on the ground
                notes.append("raw scene delivered; analysis happens on the ground")
            # Intermediate nodes must offer relay capacity unless they are the compute node (which forwards its own result).
            # Such routes are structurally impossible (not a tradeoff), so they are pruned rather than listed.
            if any(w.to != compute_at and ((_cap(nodes.get(w.to)) or {}).get("type") if nodes.get(w.to) else None) != "relay" for w in route[:-1]):
                continue
            for w in route:
                if w.status == "killed":
                    reasons.append(f"link {w.window_id} ({w.frm}→{w.to}) is down")
                if w.frm in offline or w.to in offline:
                    off = w.frm if w.frm in offline else w.to
                    reasons.append(f"provider {off} is offline")
                start = max(t, w.start)
                if start > w.end + EPS:
                    reasons.append(f"{w.window_id} ({w.frm}→{w.to}) closes at {w.end:.0f}s, data ready at {t:.0f}s")
                dur = payload * 8.0 / max(w.bandwidth_mbps, EPS)
                finish = start + dur
                if finish > w.end + EPS:
                    fits = w.bandwidth_mbps * (w.end - start) / 8.0
                    reasons.append(
                        f"{payload:.1f} MB needs {dur:.1f}s at {w.bandwidth_mbps:.0f} Mbps; {w.window_id} has {max(0.0, w.end - start):.0f}s left (fits {max(0.0, fits):.0f} MB)")
                if w.remaining_mb is not None and payload > w.remaining_mb + EPS:
                    reasons.append(f"{w.window_id} has only {w.remaining_mb:.0f} MB capacity left")
                to_node = nodes.get(w.to)
                leg = Leg(kind="transfer", window_id=w.window_id, start=start, end=finish, bytes_mb=payload, duration_s=dur,
                          frm=w.frm, to=w.to, operator_id=(to_node or {}).get("operator_id") if to_node else None)
                # relay downlink pricing
                from_node = nodes.get(w.frm)
                if w.to in gs and from_node and (_cap(from_node) or {}).get("type") == "relay":
                    q = find_quote(w.frm, w.window_id, mb=payload)
                    leg.operator_id = from_node.get("operator_id")
                    if q:
                        leg.price_usd = float(q["price_usd"]); leg.quote_id = q.get("quote_id")
                    else:
                        leg.price_usd = _estimate_price(from_node, payload, None); leg.price_estimated = True; quoted = False
                    cost += leg.price_usd
                legs.append(leg)
                t = finish
                if compute_at == w.to:
                    n = nodes[w.to]
                    cap = _cap(n)
                    cs = float(cap.get("modeled_compute_s", 30))
                    if payload > float(cap.get("max_input_mb", 1e9)):
                        reasons.append(f"{w.to} max input {cap.get('max_input_mb')} MB < {payload:.0f} MB")
                    cleg = Leg(kind="compute", window_id=w.window_id, start=t, end=t + cs, bytes_mb=payload, duration_s=cs,
                               node=w.to, op=op, model=model, operator_id=n.get("operator_id"))
                    q = find_quote(w.to, w.window_id, compute_s=cs)
                    if q:
                        cleg.price_usd = float(q["price_usd"]); cleg.quote_id = q.get("quote_id")
                    else:
                        cleg.price_usd = _estimate_price(n, payload, cs); cleg.price_estimated = True; quoted = False
                    cost += cleg.price_usd
                    legs.append(cleg)
                    t = t + cs
                    payload = result_mb
            delivery = t
            if delivery > deadline + EPS:
                reasons.append(f"delivery at {delivery:.0f}s is after deadline {deadline:.0f}s")
            if cost > budget + EPS:
                reasons.append(f"cost ${cost:.2f} exceeds budget ${budget:.2f}")
            if not quoted:
                notes.append("no quote yet for some legs; price estimated from provider manifest")
            # label
            hops = [w.frm for w in route] + [route[-1].to]
            if compute_at:
                strategy = "compute+relay"
                relays = [h for h in hops[1:-1] if h != compute_at]
                label = f"Inference on {compute_at}" + (f" → relay {' → '.join(relays)}" if relays else "") + f" → {hops[-1]}"
            elif len(route) == 1 and start_node == req.get("source_node") and not committed:
                strategy = "own-downlink"
                label = f"Own downlink {hops[0]} → {hops[-1]}"
            elif fidelity == "low":
                strategy = "raw-relay"
                label = f"Low-fidelity raw crop ({payload_start:.0f} MB) via " + " → ".join(hops[1:-1]) + f" → {hops[-1]}"
            else:
                strategy = "raw-relay" if not committed else "relay"
                label = ("Raw relay via " if not committed else "Relay via ") + " → ".join(hops[1:-1]) + f" → {hops[-1]}" if len(hops) > 2 else f"Direct {hops[0]} → {hops[-1]}"
            pid = "p_" + hashlib.sha1(("|".join(w.window_id for w in route) + f"|{compute_at}|{fidelity}").encode()).hexdigest()[:8]
            reasons = list(dict.fromkeys(reasons))  # dedupe, keep order
            plans.append(Plan(pid, label, strategy, legs, delivery, cost, feasible=not reasons, quoted=quoted, reasons=reasons, notes=notes,
                              fidelity=fidelity, payload_mb=payload_start))

    plans.sort(key=lambda p: (not p.feasible, p.cost_usd if p.feasible else 0, p.delivery_sim_t))
    _annotate_tradeoffs(plans)
    return [p.to_dict() for p in plans]


def _annotate_tradeoffs(plans: list[Plan]) -> None:
    """Fill `tradeoff` for feasible plans, relative to the other feasible plans (fastest / cheapest / fidelity / delay)."""
    feas = [p for p in plans if p.feasible]
    if not feas:
        return
    fastest = min(p.delivery_sim_t for p in feas)
    cheapest = min(p.cost_usd for p in feas)
    full = [p for p in feas if p.fidelity == "full"]
    cheapest_full = min((p.cost_usd for p in full), default=None)
    for p in feas:
        tags: list[str] = []
        if abs(p.delivery_sim_t - fastest) < 1e-6:
            tags.append("fastest")
        if abs(p.cost_usd - cheapest) < 1e-6:
            tags.append("cheapest")
        elif p.fidelity == "full" and cheapest_full is not None and abs(p.cost_usd - cheapest_full) < 1e-6 and len(full) > 1:
            tags.append("cheapest full fidelity")
        tags.append("full fidelity" if p.fidelity == "full" else "low fidelity")
        delay = p.delivery_sim_t - fastest
        if delay >= 1:
            tags.append(f"+{delay:.0f} s" + (" (late)" if delay >= 300 else ""))
        p.tradeoff = " · ".join(dict.fromkeys(tags))


def windows_from_scenario(sc: dict, statuses: dict[str, str] | None = None, moved: dict[str, float] | None = None) -> list[WindowView]:
    out = []
    for w in sc["windows"]:
        wv = WindowView(w["window_id"], w["from"], w["to"], float(w["start"]), float(w["end"]), float(w["bandwidth_mbps"]), w.get("kind", "crosslink"))
        if statuses:
            wv.status = statuses.get(w["window_id"], "future")
        wv.remaining_mb = wv.capacity_mb - float((moved or {}).get(w["window_id"], 0.0))
        out.append(wv)
    return out
