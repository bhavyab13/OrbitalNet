# OCGP benchmark — does conditional cross-owner commitment pay off?

```bash
source sim/.venv/bin/activate
python bench/run_bench.py --n 100 --seed 1      # ~10 s; writes results.csv / results.json / results.png
```

## What is being compared

Three purchasing strategies run on **identical seeded worlds** (same jittered contact windows, same prices, same
failure events), so every difference is paired:

| | Strategy | What it does when things go wrong |
|---|---|---|
| **A** | Independent purchasing | Pays for each resource the moment its quote is accepted (plain pay-per-request, one MPP 402 per resource). No holds, no refunds, no world assertion: it only learns a link is dead when the provider refuses it. |
| **B** | OCGP conditional commit (ours) | Holds every leg, pays only if all holds succeed (a provider withdrawing before commit costs $0). A paid-but-unfulfilled grant on a provider whose link dies is refunded by voucher; fulfilled work is preserved and replanning starts from the node holding the result. Waits for late providers until the deadline. |
| **C** | Omniscient central scheduler | Knows every failure and arrival in advance; buys exactly one plan that will succeed. An upper bound that **violates the independent-ownership assumption** OCGP exists for (nobody has everyone's private schedule). |

Feasibility is decided by the real planner (`sim/app/planner.py`), unchanged.

## World model (seeded per mission)
- Nodes and windows from `data/scenario.json`; window start jitter ±30 s, duration ×0.7–1.3; relay prices ×0.7–1.6, compute price ×0.8–1.3.
- Mission: deadline 480–900 s, budget $3–$8, payload 120–260 MB.
- **E2, link killed** with probability `p_fail` ∈ {0, 0.2, 0.4}: one relay downlink window dies at an absolute time before it opens.
- **E1, provider withdraws capacity** with probability `p_withdraw` ∈ {0, 0.2}: a relay operator refuses holds/purchases during an absolute interval (start 0–200 s, length 60–200 s).
- A late provider (STARLINK-3005) comes online at 200–450 s with probability 0.5.
- Negotiation latency (quote → hold → commit) is 5 sim-seconds for every strategy.

## Metrics
- **completion**: delivered before the deadline (95% bootstrap CI).
- **wasted $/mission**: money paid for grants never fulfilled and never refunded.
- **stranded/mission**: count of such grants.
- **rejected ops**: operations the provider's policy layer refused (an agent trying a dead link). Always 0 for OCGP because the world assertion makes the dead link visible before any attempt.
- **replan latency**: sim-seconds from a failure to the next commit (includes waiting for a late provider).

## What this does and does not show
- It is **preliminary simulation evidence under modeled contact windows**, not a measurement of orbital-industry performance.
- Expected result: completion rates are near-identical for A and B (both replan), and both sit within a few points of the omniscient bound; the protocol's value shows up as **zero wasted spend, zero stranded reservations and zero policy-rejected operations**, growing with the failure rate. With the default $0.50 relay floor the dollar amounts are small; the mechanism, not the magnitude, is the claim.
- It does not model: multi-mission contention for the same capacity, adversarial providers, partial transfers that resume, or on-orbit settlement.
