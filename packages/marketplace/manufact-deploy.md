# Deploying the OrbitalNet Marketplace to Manufact Cloud

The marketplace is an **mcp-use v2** server with an **MCP App** view (`views/mission-status`). It is the public, agent-facing entry point of OrbitalNet (OCGP broker).

## 0. Prereqs
- Node ≥ 22.22 (`export PATH=/opt/homebrew/opt/node@22/bin:$PATH`)
- A Manufact Cloud account (free tier covers the first server)
- `PROTOCOL.md` and `scenario.json` are copied into this package (`npm run prepare-assets`) so the deployed server can serve `ocgp://protocol` and defaults without the monorepo.

## 1. Local check
```bash
cd packages/marketplace
npm run dev            # http://localhost:3000/mcp  + inspector at /mcp/inspector
MOCK_SIM=1 npm run dev # canned world, no sim/operators needed
npx tsx scripts/smoke.ts            # list tools, discover, plan
FULL=1 npx tsx scripts/smoke.ts     # + reserve (pays via MPP), submit, poll
```

## 2. Deploy
```bash
npx -y mcp-use@latest login
npm run prepare-assets
npx -y mcp-use@latest deploy --no-github -y      # uploads this folder; Manufact builds + health-checks it
# or, from a GitHub repo with the Manufact GitHub App installed:
npx -y mcp-use@latest deploy -y
```
The CLI prints the dashboard URL and the hosted MCP URL (`https://<slug>.run.mcp-use.com/mcp`). Copy the exact URL from the dashboard.

## 3. Environment variables (Manufact dashboard → deployment → Environment)
| var | value |
|---|---|
| `SIM_URL` | **public** URL of the world simulator (`sim/`, port 8000). Expose it via an InstaBox public port, or a tunnel (`cloudflared tunnel --url http://localhost:8000` / `ngrok http 8000`). |
| `REGISTRY_SEED` | comma-separated **public** operator base URLs (InstaBox public URLs for :7001/:7002; the late provider :7003 self-registers via `POST /registry`). |
| `PAY_RAIL` | `tempo` (Tempo testnet, works without Stripe) or `stripe` (operators then run `stripe.create()` methods; SPT/Tempo via Stripe) |
| `MPPX_PRIVATE_KEY` | broker wallet private key (Tempo testnet; `npx mppx account export --account main`) |
| `ADMIN_TOKEN` | judge token forwarded to operators' `/admin/*` (optional) |

Operators must be able to reach the broker for self-registration: set their `BROKER_URL` to the hosted MCP server origin (routes `POST /registry`, `GET /registry`, `GET /health` live next to `/mcp`).

## 4. Connect a client
Claude Desktop / Claude Code / Cursor / ChatGPT: paste the hosted URL as a remote MCP server. The dashboard's "connect" panel gives per-client snippets. Example (Claude Code):
```bash
claude mcp add --transport http orbitalnet https://<slug>.run.mcp-use.com/mcp
```
Cursor `~/.cursor/mcp.json`:
```json
{ "mcpServers": { "orbitalnet": { "url": "https://<slug>.run.mcp-use.com/mcp" } } }
```
Then use the `run_mission` prompt, or just ask: *"Deliver the Papua wildfire assessment within 12 minutes for under $6."* The `get_mission_status` tool renders the live mission card (MCP App) inside the chat.

## 5. Notes
- No OAuth is configured: the server is public. Judge tools (`inject_disruption`, `reset_world`) are intentionally open for the demo.
- Manufact's analytics tab shows which clients called which tools — useful evidence that external agents drove the marketplace.
