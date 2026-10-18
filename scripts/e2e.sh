#!/usr/bin/env bash
# End-to-end rehearsal against a running stack: mission → disruption → late provider → delivery.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
set -a; source .env; set +a
SIM=${SIM_URL:-http://localhost:8000}
status() { curl -s $SIM/missions/fire-001 | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status'), '| leg', d.get('current_leg'), '| committed', (d.get('committed') or {}).get('node_id'), '| paid', d.get('total_paid_usd'))" 2>/dev/null; }
lsof -ti:7003 | xargs kill 2>/dev/null
echo "== reset (broker + world + operators)"; curl -s -X POST ${BROKER_URL:-http://localhost:3000}/reset -o /dev/null || curl -s -X POST $SIM/reset -o /dev/null
echo "== JUDGE (E1): Lumen Relay will withdraw at commit"; curl -s -X POST $SIM/disrupt -H 'content-type: application/json' -d '{"type":"competing_reserve","node_id":"EDRS-C","fraction":0,"fail_next_hold":true,"label":"E1: Lumen Relay withdraws capacity at commit"}' -o /dev/null
echo "== buyer (auto)"; (cd packages/buyer && npm run buyer -- --auto > ../../.logs/buyer.log 2>&1 &) 
for i in $(seq 1 90); do sleep 2; s=$(status); [[ "$s" == *"committed PHISAT-2"* ]] && break; done
echo "   $(status)"
echo "== JUDGE: kill C downlink"; curl -s -X POST $SIM/disrupt -H 'content-type: application/json' -d '{"type":"kill_link","window_id":"w_C_GS_1"}' | head -c 200; echo
for i in $(seq 1 30); do sleep 2; s=$(status); [[ "$s" == REPLAN* || "$s" == INFEASIBLE* ]] && break; done
echo "   $(status)"
sleep 6; echo "   buyer says:"; grep -E "Disruption|INFEASIBLE|No feasible" .logs/buyer.log | tail -2
echo "== JUDGE: launch provider D"; (cd packages/operator && nohup npm run dev:starlink > ../../.logs/op-starlink.log 2>&1 &)
sleep 5; curl -s -X POST $SIM/disrupt -H 'content-type: application/json' -d '{"type":"launch_provider","node_id":"STARLINK-3005"}' -o /dev/null
for i in $(seq 1 120); do sleep 2; s=$(status); [[ "$s" == DELIVERED* || "$s" == INFEASIBLE* || "$s" == FAILED* ]] && break; done
echo "== FINAL: $(status)"
echo "== buyer narration:"; grep "^\[buyer\]" .logs/buyer.log | cut -c1-220
