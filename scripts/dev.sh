#!/usr/bin/env bash
# Start the whole OrbitalNet stack locally. Usage: scripts/dev.sh [--no-buyer]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
cd "$ROOT"
set -a; source .env; set +a
mkdir -p .logs
pids=()
cleanup() { echo; echo "stopping…"; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "▶ sim :8000";            (cd sim && ./run.sh) > .logs/sim.log 2>&1 & pids+=($!)
sleep 3
echo "▶ broker :3000";         (cd packages/marketplace && npm run dev) > .logs/marketplace.log 2>&1 & pids+=($!)
echo "▶ operator PHISAT-2 :7001"; (cd packages/operator && npm run dev:phisat) > .logs/op-phisat.log 2>&1 & pids+=($!)
echo "▶ operator EDRS-C :7002";   (cd packages/operator && npm run dev:edrs) > .logs/op-edrs.log 2>&1 & pids+=($!)
# STARLINK-3005 (northstar-relay) is NOT started: the judge launches it mid-demo via /disrupt launch_provider
echo "▶ dashboard :5173";      (cd dashboard && npm run dev -- --host) > .logs/dashboard.log 2>&1 & pids+=($!)
sleep 4
echo
echo "  dashboard  http://localhost:5173        judge phone  http://$(ipconfig getifaddr en0 2>/dev/null || echo localhost):5173/judge"
echo "  broker MCP http://localhost:3000/mcp    inspector    http://localhost:3000/mcp/inspector"
echo "  sim        http://localhost:8000/state  logs         .logs/*.log"
echo
if [[ "${1:-}" != "--no-buyer" ]]; then
  echo "Press ENTER to launch the buyer agent (or Ctrl-C to stop everything)…"; read -r
  (cd packages/buyer && npm run buyer -- "${@:2}")
fi
wait
