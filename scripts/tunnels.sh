#!/usr/bin/env bash
# Open cloudflared quick tunnels for the sim and operators and write their URLs into .env (PUBLIC_URL_*).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"; mkdir -p .logs
pkill -f "cloudflared tunnel" 2>/dev/null || true; sleep 1
declare -A MAP=([8000]=SIM [7001]=PHISAT [7002]=EDRS [7003]=STARLINK)
for p in 8000 7001 7002 7003; do (nohup cloudflared tunnel --url http://localhost:$p > .logs/tunnel-$p.log 2>&1 &); done
sleep 12
for p in 8000 7001 7002 7003; do
  url=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' .logs/tunnel-$p.log | head -1)
  key=PUBLIC_URL_${MAP[$p]}
  if grep -q "^$key=" .env; then sed -i '' "s|^$key=.*|$key=$url|" .env; else echo "$key=$url" >> .env; fi
  echo "$key=$url"
done
sim=$(grep "^PUBLIC_URL_SIM=" .env | cut -d= -f2); if grep -q "^SIM_PUBLIC_URL=" .env; then sed -i "" "s|^SIM_PUBLIC_URL=.*|SIM_PUBLIC_URL=$sim|" .env; else echo "SIM_PUBLIC_URL=$sim" >> .env; fi
echo "Now: restart operators (they advertise PUBLIC_URL) and update the Manufact env: SIM_URL + REGISTRY_SEED."
