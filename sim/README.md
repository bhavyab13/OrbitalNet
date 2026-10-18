# sim — the OrbitalNet "World"

Physics authority (sim clock, real SGP4 orbits, contact windows, byte-accurate transfers), the time-expanded **planner**, and the **mission runner** that drives the independent operator services. Implements `docs/API.md` §1.

## Run
```bash
cd sim && uv pip install -e . --python .venv/bin/python   # or: source .venv/bin/activate
./run.sh                                 # http://localhost:8000  (Swagger at /docs, events at ws://localhost:8000/ws)
python -m pytest -q                      # planner unit tests
python scripts/smoke.py                  # prints nodes, windows, a signed world assertion and the plan table
```
Env: `SCENARIO` (default `data/scenario.json`), `SIM_PUBLIC_URL` (what operators use to fetch `/scene/image`), `OPERATOR_URLS` (`orbital-foundry=http://localhost:7001,…`), `ADMIN_TOKEN`, `LAUNCH_CMD_<NODE_ID>` (shell command run by `launch_provider`).

## Curl walkthrough
```bash
curl -s localhost:8000/state | jq '.sim_t, .windows[0]'
curl -s 'localhost:8000/positions?from=0&to=600&step=30' | jq '.["PHISAT-2"][0:3]'
curl -s 'localhost:8000/assert?window_id=w_A_B_1' | jq            # signed World Assertion
curl -s -X POST localhost:8000/plan -H 'content-type: application/json' -d '{"now_sim_t":0}' | jq '.plans[] | {label,feasible,cost_usd,delivery_sim_t,reasons}'
# choose a plan, obtain grants from operators (see packages/marketplace), then:
curl -s -X POST localhost:8000/missions -H 'content-type: application/json' -d '{"plan": <plan>, "grants": {"1": <grant>, "3": <grant>}}'
curl -s localhost:8000/missions/fire-001 | jq '.status, .legs[].status'
curl -s -X POST localhost:8000/disrupt -H 'content-type: application/json' -d '{"type":"kill_link","window_id":"w_C_GS_1"}'
curl -s -X POST localhost:8000/missions/fire-001/resume -d '{"plan": <new plan>, "grants": {...}}'
curl -s -X POST localhost:8000/clock -d '{"action":"set_accel","accel":8}'
curl -s -X POST localhost:8000/reset
```
Grants are keyed by **leg index** of the plan (string keys). Compute legs and relay-downlink legs need grants; own-operator legs and crosslinks into a relay do not.

## Events on /ws
`hello` (full state), `tick`, `window_open/close`, `transfer_progress`, `leg_start/leg_done/leg_failed`, `fulfilment_request`, `grant_rejected`, `mission_status`, `plan_chosen`, `plans_computed`, `replan_required`, `link_killed/link_restored`, `competing_mission`, `provider_online`, `revoked`, `refund`, `delivered`, `infeasible`, `narration {act,text}`, `clock`, `reset`, plus anything pushed by operators/buyer via `POST /events` (`payment`, `grant_issued`, …).

## Honesty
Positions are real SGP4 propagation of real CelesTrak TLEs at the scenario epoch. Contact windows, bandwidths, power and prices are modeled scenario values (`data/scenario.json`).
