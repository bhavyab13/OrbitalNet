# Sponsor setup — exactly what YOU need to do at the venue (≈20 min total)

Everything runs locally today with **no accounts**: payments go over Tempo testnet through real MPP 402 challenges (already verified), the MCP broker runs locally, operators run as local processes. The steps below swap each piece onto the sponsor's real platform. Do them in this order; each is independent.

## 1. Stripe (track: machine payments) — DONE 2026-10-18
Sandbox acct `acct_1URuY0GhDL5moMEd`, profile `profile_test_61VbIg…`, Tempo deposit address created; `PAY_RAIL=stripe`. Each `/reserve` 402 offers `stripe` (SPT card) + `tempo` (via Stripe deposit address). PaymentIntents appear at https://dashboard.stripe.com/test/payments.

What judges will see either way: real MPP `402 Payment Required` challenges, signed receipts, tx hashes. With Stripe keys they ALSO see PaymentIntents land in the Stripe Dashboard.
1. Create a sandbox at https://dashboard.stripe.com → Developers → API keys → copy `sk_test_…`.
2. Create a Business Profile: `curl https://api.stripe.com/v2/network/business_profiles/me -u sk_test_XXX: -H "Stripe-Version: 2026-07-29.preview"` → copy the `profile_test_…` id.
3. Create a Tempo deposit address: `curl https://api.stripe.com/v1/crypto/deposit_addresses -u sk_test_XXX: -H "Stripe-Version: 2026-07-29.preview" -d network=tempo` → copy `address`.
4. In `.env`: `PAY_RAIL=stripe`, `STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_PROFILE_ID=profile_test_…`, `TEMPO_DEPOSIT_ADDRESS=…`. Restart operators.
5. Validate one operator: `npx mppx@latest validate http://localhost:7002` (expect all green). Also talk to Peter (Stripe YC lead) and show him the `/reserve` → grant flow; ask for their hackathon cheat-sheet link.

## 2. Manufact (track: best MCP server / MCP App) — DONE 2026-10-18
Hosted: `https://calm-wave-z8g51.run.mcp-use.com/mcp` (server `orbitalnet-marketplace`, slug `calm-wave-z8g51`). Redeploy: `cd packages/marketplace && npm run prepare-assets && npx -y mcp-use@latest deploy --no-github -y`. Update env after new tunnels: `npx -y mcp-use@latest servers env set calm-wave-z8g51 SIM_URL=… ` and `REGISTRY_SEED=…`.
Claude Code: `claude mcp add --transport http orbitalnet https://calm-wave-z8g51.run.mcp-use.com/mcp`. Claude Desktop: Settings → Connectors → Add custom connector → that URL.

1. `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`
2. `cd packages/marketplace && npx -y mcp-use@latest login` (browser login).
3. The broker must reach the sim and operators from the cloud. Either (a) run them on InstaBox (step 3) and put their public URLs in the deploy env, or (b) tunnel: `brew install cloudflared && cloudflared tunnel --url http://localhost:8000` (one per service) and paste the URLs.
4. `npx -y mcp-use@latest deploy --no-github -y` → set env vars in the Manufact dashboard: `SIM_URL`, `REGISTRY_SEED`, `MPPX_PRIVATE_KEY`, `PAY_RAIL`.
5. Copy the MCP URL; add it to Claude Desktop (Settings → Connectors) so a judge can type "run the Papua fire mission" and watch the MCP App widget render. Tell the Manufact folks you used MCP Apps + the `ocgp://protocol` resource for self-onboarding.

## 3. InstaBox (track: best use of agent computers) — DONE 2026-10-18
Boxes (account bhavyab13): `orbital-foundry` (PHISAT-2 compute, https://7001-agqu6w7vgunkts2l5yop63jie4.instabox.tech), `lumen-relay` (EDRS-C relay, https://7002-agqu6xts2sw3yul4iq7yfow2wq.instabox.tech), `northstar-relay` (STARLINK-3005, https://7003-agqu6xuufihmjk27jkjrx2n4ia.instabox.tech, **kept idle**: the judge's "new provider" button runs `instabox ssh northstar-relay -- /data/workspace/run-operator.sh starlink <url>` via the sim's LAUNCH_CMD). Snapshot `orbitalnet-operator` has repo+deps+keys+.env.
Before the demo: `instabox ls` (wake paused boxes with `instabox wake <box>`), then `instabox ssh orbital-foundry -- '/data/workspace/run-operator.sh phisat <url>'` and the same for `lumen-relay … edrs <url>` (boxes auto-pause after 30 idle min; a public-port request wakes them but the operator process must be restarted after a pause). Show the InstaBox console on the second screen when Northstar boots.
Original setup steps for reference:
Invitation code **556677** (from the stage). Default 4 vCPU / 8 GB, up to 5 machines (ask them to raise it).
1. `npx instabox@latest` → sign in, enter the code.
2. Follow `packages/operator/deploy-instabox.md`: create box `orbital-foundry`, clone/copy the repo, `npm i`, run the compute operator with `PUBLIC_URL=<box public url>`; expose port 7001 publicly. Snapshot it.
3. Boot `lumen-relay` from the snapshot with `NODE_ID=EDRS-C OPERATOR_ID=lumen-relay PORT=7002`. Expose 7002.
4. Keep a THIRD box ready but STOPPED: `northstar-relay` (`NODE_ID=STARLINK-3005`). During the demo, the judge's "new provider online" button (or you, in the InstaBox console) starts it; it self-registers with the broker within 10 s. This is the moment to point at the InstaBox console on the second screen.
5. Set `REGISTRY_SEED` (broker) and `OPERATOR_URLS` (sim) to the public box URLs.

## 4. Anthropic key (buyer agent) — 1 min
`ANTHROPIC_API_KEY=…` in `.env`. Without it the buyer runs in deterministic mode (same protocol flow, no LLM narration).

## 5. Optional: Armature — if everything above is done
Ask them for an SDK key, `npm i @armature/mcp` (or whatever they name it) in `packages/marketplace`, wrap the server per their README (3 lines), and show agent-session analytics of the judge's Claude Desktop run.
