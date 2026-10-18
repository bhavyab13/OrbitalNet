# Manufact "Best MCP" track — submission bundle (due Sun Oct 18, 10:00 AM PT)

Submit at **url.mcp-use.com/yc-submit** (one entry per team):

| Field | Value |
|---|---|
| Team name | OrbitalNet |
| MCP server URL | `https://calm-wave-z8g51.run.mcp-use.com/mcp` |
| Manufact organization ID | `074d2b7b-1ec8-41d7-82c8-421ed445083e` |
| Demo video URL | (record with the script below, upload unlisted to YouTube/Loom, paste link) |

## What the judges score (from their slides) and our answer
1. **Why MCP?** An agent that needs satellite compute/relay today must integrate each operator's API by hand. OrbitalNet exposes one MCP surface — discover → quote → plan → reserve (pays) → execute → reconcile — so *any* agent in *any* client can buy orbital capacity with no integration code. The MCP App (mission card) shows live legs, payments and the delivered fire map inside the chat; a website could not run *inside the agent's loop*. Resource `ocgp://protocol` lets an unfamiliar agent read the rules; prompt `run_mission` gives it the workflow.
2. **MCP quality.** 10 tools with zod input+output schemas, `.describe()` on every field, read-only/destructive annotations, structuredContent on every result, machine-readable errors (`{ok:false, reason}`), 2 resources, 1 prompt, icons. Tested in Claude Code, Cursor, Codex and the mcp-use inspector (see video). Hosted on Manufact (`npx mcp-use deploy`).
3. **UX & scale.** Zero-auth public endpoint, first useful call in one message ("run the Papua fire mission"). Potential: every satellite tasking / relay / edge-compute purchase is a tool call; the protocol generalises to GPU reservations, drone corridors, edge cameras.

## Demo video script (≤ 2 min, screen recording, no slides)
0:00 Terminal: `claude mcp add --transport http orbitalnet https://calm-wave-z8g51.run.mcp-use.com/mcp` → `claude` → `/mcp` shows orbitalnet connected, 10 tools.
0:15 Fresh world first (say nothing, or "reset"): *"Use orbitalnet reset_world"*. Then type: *"Use orbitalnet: discover providers, then plan and run mission fire-001 — responders need a fire-front perimeter over Papua in 12 minutes, budget $6. Pick the plan and explain why."* Show tool calls streaming (discover_providers → plan_mission → reserve_path → submit_mission) and the plan table in the answer.
0:50 Second screen: the OrbitalNet mission control (localhost:5173) reacting live — payments, links, inference on the InstaBox satellite.
1:05 Cursor: open Settings → MCP (same URL already configured) → in chat: *"get_mission_status for fire-001"* → show the structured status (and the mission-card widget in the local mcp-use inspector at `http://localhost:3000/mcp/inspector` — the hosted URL has no inspector — if Cursor doesn't render views).
1:30 Codex: `codex` → `/mcp` list shows orbitalnet → *"reconcile_mission fire-001"* → receipts ↔ grants ↔ attestations all agree.
1:45 Manufact dashboard: the server page with analytics showing calls from three clients. End card: repo URL + MCP URL.

## Reproduce in 60 seconds (for judges)
```bash
claude mcp add --transport http orbitalnet https://calm-wave-z8g51.run.mcp-use.com/mcp
claude            # then: "Use orbitalnet to discover providers and plan mission fire-001"
```
Cursor `~/.cursor/mcp.json`: `{"mcpServers":{"orbitalnet":{"url":"https://calm-wave-z8g51.run.mcp-use.com/mcp"}}}`
Codex `~/.codex/config.toml`: `[mcp_servers.orbitalnet]\nurl = "https://calm-wave-z8g51.run.mcp-use.com/mcp"`
Inspector (local dev server only): http://localhost:3000/mcp/inspector

## Before recording / before judges connect (hosted server checklist)
- Dry run the exact judge path over the hosted URL: `scripts/manufact-dryrun.sh` (resets the shared sim; ~3 min; ends with DELIVERED + reconcile).
- The hosted broker reaches the sim through a cloudflared quick tunnel. If the tunnel is recreated, `scripts/retunnel.sh` sets the new `SIM_URL` in Manufact — **but a running deployment does not pick up env changes; redeploy after any env change**: `cd packages/marketplace && npm run prepare-assets && npx -y mcp-use@latest deploy --no-github -y` (~2 min).
- `npm run prepare-assets` inlines `docs/PROTOCOL.md` + `data/scenario.json` into `src/assets.gen.ts`; without it the hosted server has no mission defaults and `ocgp://protocol` is empty.
- InstaBox boxes auto-pause after 30 idle minutes; `instabox ls`, then restart the operators (see docs/SPONSORS.md §3) so `discover_providers` shows 2 verified providers.
