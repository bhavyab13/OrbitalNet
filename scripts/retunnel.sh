#!/usr/bin/env bash
# Re-create the sim's public tunnel and propagate the new URL everywhere (boxes + hosted broker + local sim).
set -o pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"; export PATH=/opt/homebrew/opt/node@22/bin:$PATH
pkill -f "cloudflared tunnel --url http://localhost:8000" 2>/dev/null || true; sleep 1
(nohup cloudflared tunnel --url http://localhost:8000 > .logs/tunnel-8000.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; url=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' .logs/tunnel-8000.log | head -1 || true); [[ -n "$url" ]] && break; done
[[ -z "$url" ]] && { echo "no tunnel url"; exit 1; }
sed -i '' "s|^PUBLIC_URL_SIM=.*|PUBLIC_URL_SIM=$url|; s|^SIM_PUBLIC_URL=.*|SIM_PUBLIC_URL=$url|" .env
echo "sim tunnel: $url"
set -a; source .env; set +a
# hosted broker
(cd packages/marketplace && timeout 120 npx -y mcp-use@latest servers env set 300caa48-8456-45ce-9bc0-2434420473dd "SIM_URL=$url" --json | tail -1)
# boxes: new .env + restart the live operators (northstar stays idle)
for b in orbital-foundry lumen-relay northstar-relay; do instabox ssh $b -- 'cat > /data/workspace/OrbitalNet/.env' < .env; done
instabox ssh orbital-foundry -- "/data/workspace/run-operator.sh phisat $INSTABOX_URL_PHISAT" | tail -1
instabox ssh lumen-relay -- "/data/workspace/run-operator.sh edrs $INSTABOX_URL_EDRS" | tail -1
# local sim restart (listening process only — never kill tunnels)
lsof -ti TCP:8000 -sTCP:LISTEN | xargs kill 2>/dev/null || true; sleep 1
(cd sim && source .venv/bin/activate && nohup ./run.sh > ../.logs/sim.log 2>&1 &)
for i in $(seq 1 20); do sleep 1; curl -s -o /dev/null localhost:8000/state && break; done
echo "sim up; via tunnel: $(curl -s -o /dev/null -w '%{http_code}' $url/state)"
