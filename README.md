# OrbitalNet

**An open marketplace and protocol (OCGP) that lets independently operated satellites discover, negotiate, pay for, and execute deadline-feasible combinations of orbital compute and relay capacity — with physics, policy, and payments enforced in code.**

- `docs/PROTOCOL.md` — the OrbitalNet Capacity Grant Protocol (the technical contribution)
- `docs/API.md` — service contracts every component implements
- `PLAN.md` — build plan and demo script
- `data/scenario.json` — the canonical demo scenario (real TLEs, real VIIRS fire data, modeled contact windows)

Components: `sim/` (world + planner + runner, Python) · `packages/operator` (independent provider service, TS, runs on InstaBox) · `packages/marketplace` (MCP broker on Manufact) · `packages/buyer` (Claude agent) · `dashboard/` (3D Earth mission control).

Sponsors: **Stripe** (MPP machine payments) · **Manufact** (MCP Cloud + MCP Apps) · **InstaBox** (independent operator machines).

## Run it (local, no accounts needed)
```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm i && (cd dashboard && npm i) && (cd sim && uv venv .venv -p 3.11 && source .venv/bin/activate && uv pip install -e .)
python3 scripts/gen-keys.py                      # Ed25519 keys for world/broker/operators (already generated)
scripts/dev.sh                                   # sim :8000 · broker :3000 · operators :7001/:7002 · dashboard :5173, then ENTER launches the buyer
scripts/e2e.sh                                   # scripted rehearsal: E1 withdraw → pay → compute → E2 outage → late provider → delivered
```
Judge phone: `http://<laptop-ip>:5173/judge`. Payments: real MPP 402 challenges on Tempo testnet (wallets in `.env`); set `PAY_RAIL=stripe` + keys for Stripe sandbox receipts. Benchmark: `source sim/.venv/bin/activate && python bench/run_bench.py --n 100` → `bench/results.png`.
Sponsor steps for the venue: `docs/SPONSORS.md`. Demo script: `docs/DEMO.md`.
