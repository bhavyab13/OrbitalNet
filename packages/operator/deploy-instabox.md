# Running operator nodes on InstaBox (InsForge)

Each satellite operator is an **independently administered machine**: its own box, its own Ed25519 key, its own Tempo/Stripe recipient, its own policy. Three boxes = three operators. A snapshot lets a brand-new provider join mid-demo.

## 0. One-time
```bash
npx instabox@latest            # sign in (invitation code 556677 for the hackathon quota: 4 vCPU / 8 GB, up to 5 boxes)
npx instabox@latest help       # list CLI commands (create / ssh / ports / snapshot / …)
```
> The CLI was published on 2026-10-14; if a subcommand name below differs, `npx instabox@latest help` is authoritative. Everything also works from the web console (Machines → New, Ports, Snapshots).

## 1. Create the first box and install the node
```bash
npx instabox@latest sh                     # creates a box and opens an SSH shell
# --- inside the box ---
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs python3 python3-pip git
pip3 install --break-system-packages numpy pillow
git clone <your repo url> orbitalnet && cd orbitalnet      # or: scp -r the repo from your laptop
npm install --workspaces --include-workspace-root && npm i -g tsx
```
Copy `.env` (not committed) to the box. Then set the node identity and **public URL** (from the box's Ports page: expose port 7002 → you get `https://<box>-7002.instabox.sh`-style URL):
```bash
cd packages/operator
export NODE_ID=EDRS-C OPERATOR_ID=lumen-relay PORT=7002 \
       PUBLIC_URL=https://<public-url-for-7002> \
       SIM_URL=https://<public sim url> BROKER_URL=https://<manufact mcp url without /mcp> \
       PAY_RAIL=tempo
nohup tsx src/index.ts > op.log 2>&1 &
curl -s $PUBLIC_URL/.well-known/ocgp.json | head -c 300
```
The node registers itself with the broker (`POST $BROKER_URL/registry`) and announces `provider_online` to the World.

Alternatively with Docker (if the box has Docker): `docker build -f packages/operator/Dockerfile -t orbitalnet-operator . && docker run -p 7002:7000 --env-file .env -e NODE_ID=EDRS-C -e OPERATOR_ID=lumen-relay -e PUBLIC_URL=... orbitalnet-operator`.

## 2. Snapshot it
Console → the box → **Snapshots → Create** (name it `orbitalnet-operator`). This captures Node, Python, the repo and deps.

## 3. The "new provider joins" moment (Act 5)
From the judge's phone or the console: **Machines → New → from snapshot `orbitalnet-operator`**. SSH in (or use the box's startup command) and run:
```bash
cd orbitalnet/packages/operator
export NODE_ID=STARLINK-3005 OPERATOR_ID=northstar-relay PORT=7003 PUBLIC_URL=https://<public-url-for-7003> SIM_URL=... BROKER_URL=... PAY_RAIL=tempo
tsx src/index.ts
```
Because `keys/northstar-relay.json` is a different key and `TEMPO_RECIPIENT_northstar_relay` a different wallet, this is a cryptographically distinct operator. Within ~5 s it registers; the buyer agent discovers it on its next `discover_providers` call and can contract with it with zero integration code (its manifest is self-describing).

If no key file exists for the operator id on a fresh box, the service generates an ephemeral key at boot (still a distinct identity).

## 4. The compute box (PHISAT-2)
Same as step 1 with `NODE_ID=PHISAT-2 OPERATOR_ID=orbital-foundry PORT=7001`. Inference runs on the box CPU (`inference/fire_detect.py`, ~1.5 s for the 1536² scene). Verify: `curl $PUBLIC_URL/status`.

## Local fallback (no InstaBox)
```bash
npm run dev:phisat   # :7001
npm run dev:edrs     # :7002
npm run dev:starlink # :7003  (start this one later for the Act 5 moment)
```
