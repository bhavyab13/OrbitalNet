#!/usr/bin/env bash
# DIRECTOR: runs the scripted 2-minute demo with cues fired at fixed sim times so narration lines up.
# Usage: scripts/director.sh [--provider openai|auto] [--no-e1]
# Cues (sim seconds, accel 4 → ÷4 for real seconds after mission start):
#   T+0    mission arrives (buyer starts)              T+~20  agent chooses + pays (2 Stripe payments)
#   T+60   A→B crosslink opens, 180 MB flows           T+75   PHISAT-2 (InstaBox) runs real inference
#   T+125  CUE 1: ground-station outage (E2)           T+135  refund voucher, "no feasible path", waiting
#   T+150  CUE 2: Northstar box boots (InstaBox)       T+165  agent verifies manifest, pays Northstar
#   T+380  B→D crosslink, T+430 metered downlink (Stripe session), DELIVERED ~T+436
set -o pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"; export PATH=/opt/homebrew/opt/node@22/bin:$PATH
set +u; set -a; source .env; set +a
SIM=${SIM_URL:-http://localhost:8000}; PROVIDER=auto; E1=1  # default: deterministic agent (no LLM); --provider openai for LLM-chosen plans
while [[ $# -gt 0 ]]; do case "$1" in --provider) PROVIDER=$2; shift 2;; --no-e1) E1=0; shift;; *) shift;; esac; done
simt() { curl -s $SIM/state | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["sim_t"]))' 2>/dev/null || echo 0; }
status() { curl -s $SIM/missions/fire-001 | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status'))" 2>/dev/null; }
cue() { echo; echo "┌─ CUE $(date +%H:%M:%S) sim T+$(simt)s: $1"; }
mkdir -p .logs
# fresh world, idle Northstar
instabox ssh northstar-relay -- 'pkill -f "tsx src/index.ts" || true' >/dev/null 2>&1 || true
curl -s -X POST ${BROKER_URL:-http://localhost:3000}/reset -o /dev/null
# demo pace: 2x sim speed so the cues land on the 2-minute narration (override with ACCEL=4)
curl -s -X POST $SIM/clock -H 'content-type: application/json' -d "{\"action\":\"set_accel\",\"accel\":${ACCEL:-2}}" -o /dev/null
sleep 2
[[ $E1 == 1 ]] && { cue "E1 armed — Lumen Relay will withdraw at commit"; curl -s -X POST $SIM/disrupt -H 'content-type: application/json' -d '{"type":"competing_reserve","node_id":"EDRS-C","fraction":0,"fail_next_hold":true,"label":"E1: Lumen Relay withdraws capacity at commit"}' -o /dev/null; }
cue "MISSION ARRIVES — buyer ($PROVIDER) starts"
(cd packages/buyer && npm run buyer -- --provider $PROVIDER > ../../.logs/buyer.log 2>&1 &)
# CUE 1 at compute done (committed at PHISAT-2) or T+125, whichever later
until s=$(curl -s $SIM/missions/fire-001 | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('committed') or {}).get('node_id',''))" 2>/dev/null); [[ "$s" == "PHISAT-2" ]]; do sleep 2; done
while [[ $(simt) -lt 125 ]]; do sleep 1; done
cue "GROUND STATION OUTAGE (E2) — Punta Arenas link killed"
curl -s -X POST $SIM/disrupt -H 'content-type: application/json' -d '{"type":"kill_link","window_id":"w_C_GS_1","label":"Ground station outage at Punta Arenas"}' -o /dev/null
until [[ "$(status)" == "REPLAN_REQUIRED" ]]; do sleep 1; done
until grep -q "No feasible path\|Watching the marketplace\|wait" .logs/buyer.log; do sleep 1; done; sleep 4
cue "NEW PROVIDER — Northstar Relay boots on InstaBox"
curl -s -X POST $SIM/disrupt -H 'content-type: application/json' -d '{"type":"launch_provider","node_id":"STARLINK-3005"}' -o /dev/null
# once the Northstar leg is paid and running, fast-forward the world to just before its crosslink window (T+372)
until grep -q "Relay via STARLINK-3005" .logs/buyer.log && [[ "$(status)" == "RUNNING" ]]; do sleep 1; st=$(status); [[ "$st" == "DELIVERED" || "$st" == "INFEASIBLE" ]] && break; done
if [[ $(simt) -lt 410 ]]; then sleep 3; cue "FAST-FORWARD to the Starlink crosslink (T+376)"; curl -s -X POST $SIM/clock -H 'content-type: application/json' -d '{"action":"jump","to_sim_t":376}' -o /dev/null; fi
until st=$(status); [[ "$st" == "DELIVERED" || "$st" == "INFEASIBLE" || "$st" == "FAILED" ]]; do sleep 2; done
cue "END — $st"
curl -s $SIM/missions/fire-001 | python3 -c "import json,sys; d=json.load(sys.stdin); print('delivered T+%s  paid \$%s  fidelity %s' % (d.get('delivered_sim_t'), d.get('total_paid_usd'), d.get('fidelity')))"
echo "reconcile: $(curl -s ${BROKER_URL:-http://localhost:3000}/reconcile/fire-001 | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("summary"), "ok" if d.get("ok") else "VIOLATIONS")' 2>/dev/null)"
