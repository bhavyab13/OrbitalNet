#!/usr/bin/env bash
# Drive the HOSTED Manufact MCP server (what a judge's client does) end-to-end over plain JSON-RPC:
# reset_world → discover_providers → plan_mission → reserve_path (pays via MPP) → submit_mission → poll get_mission_status.
# Usage: scripts/manufact-dryrun.sh [--yes]   (--yes skips the "this resets the shared sim" prompt)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"; set -a; source .env; set +a
URL=${MANUFACT_MCP_URL:?MANUFACT_MCP_URL missing in .env}
call() { curl -s -m 90 "$URL" -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" | grep '^data:' | cut -c6-; }
text() { python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(('ERROR ' if r.get('isError') else '')+r['content'][0]['text'])"; }
[[ "${1:-}" == "--yes" ]] || { read -r -p "This resets the shared sim world (anything mid-mission is lost). Continue? [y/N] " a; [[ "$a" == y* ]] || exit 1; }
echo "== $URL"; echo "== reset_world";        call reset_world '{}' | text | head -3
echo "== discover_providers"; call discover_providers '{}' | text
echo "== plan_mission";       plan=$(call plan_mission '{"mission_id":"fire-001"}'); echo "$plan" | text
pid=$(echo "$plan" | python3 -c "import sys,json; ps=[p for p in json.load(sys.stdin)['result']['structuredContent']['plans'] if p['feasible']]; ps.sort(key=lambda p:(p.get('fidelity')!='full', p['delivery_sim_t'])); print(ps[0]['plan_id'] if ps else '')")
[[ -z "$pid" ]] && { echo "no feasible plan — INFEASIBLE (honest). Stop."; exit 2; }
echo "== reserve_path $pid (MPP payments → signed grants)"; call reserve_path "{\"mission_id\":\"fire-001\",\"plan_id\":\"$pid\"}" | text | head -12
echo "== submit_mission";     call submit_mission "{\"mission_id\":\"fire-001\",\"plan_id\":\"$pid\"}" | text | head -3
echo "== get_mission_status (poll)"
for i in $(seq 1 90); do sleep 4; s=$(call get_mission_status '{"mission_id":"fire-001"}' | text); echo "   $s" | cut -c1-200; [[ "$s" == *DELIVERED* || "$s" == *INFEASIBLE* || "$s" == *FAILED* ]] && break; done
echo "== reconcile_mission";  call reconcile_mission '{"mission_id":"fire-001"}' | text | head -12
