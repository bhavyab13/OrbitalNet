# OrbitalNet — Build Plan

**One line:** An MCP-accessible brokerage where independently operated satellites discover, negotiate, pay for, and execute deadline-feasible combinations of orbital compute and relay capacity — with physics, policy, and payments all enforced in code.

**Status:** Plan locked 2026-10-17. Implementation next.

---

## 1. Decisions

### 1.1 Sponsor tracks (three)

| # | Sponsor | Verified product | What we build with it | Why this one |
|---|---------|------------------|------------------------|--------------|
| 1 | **Stripe** (fixed) | Machine Payments Protocol (MPP) — `mppx` npm SDK, HTTP 402 challenge → pay → receipt. Sandbox: `sk_test_`, `profile_test_` ID, Tempo testnet auto-configured. Validate with `npx mppx@latest validate`. | Every provider endpoint that commits scarce capacity (`/reserve`, `/execute`, `/transmit`) is MPP-gated. The buyer agent pays automatically via the `mppx/client` fetch wrapper. Payments show up live in the Stripe sandbox Dashboard during the demo. | Core: without payment, independent operators have no reason to sell capacity. |
| 2 | **Manufact** (notes called it "Manifek") | MCP Cloud. TypeScript `mcp-use` v2 framework, `npx mcp-use deploy --no-github`, public URL `https://<slug>.run.mcp-use.com/mcp`, inspector, analytics, MCP Apps (interactive widgets). | The **OrbitalNet Marketplace MCP server** — the single public entry point. Tools: `discover_providers`, `get_contact_windows`, `request_quotes`, `plan_mission`, `reserve_path`, `submit_mission`, `get_mission_status`, `inject_disruption`. A judge can connect Claude Desktop/Cursor to it and run a mission with zero custom code. | Core: this is the "protocol" surface. Manufact's analytics dashboard doubles as proof judges used it. |
| 3 | **InstaBox** (InsForge; notes called it "Insparge") | Cloud computers for agents. 4 vCPU / 8 GB / 20 GiB Linux, <1 s boot, public URLs for local ports, snapshots, CLI `npx instabox@latest`. Launched 2026-10-14. | Each satellite **operator service runs on its own InstaBox** with its own Ed25519 signing key, policy file, and capacity ledger. The compute satellite runs **real wildfire inference** there. The "new provider joins mid-demo" moment = spin a fresh box from a snapshot, it self-registers with a new identity, the buyer discovers and contracts with it. | Makes "independently administered" literally true, and makes the surprise moment a real infra event instead of a config flag. |

**Not chosen:** Inkbox (excluded by you). Primitive (email for agents — no fit for store-and-forward orbital links). Exo (local model partitioning — not scheduling across intermittent links). **Armature** is the designated 4th track *if* the three above are done by the midpoint: ~1 hour to instrument the MCP server with their SDK and show agent-session analytics. It's also the fallback 3rd track if InstaBox (3 days old) proves unusable.

**Stripe constraint that shapes pricing:** card payments via Shared Payment Tokens have a **$0.50 minimum**; Tempo stablecoin payments go down to $0.01. So: mission budgets are in the $3–$8 range, every individual charge is ≥ $0.50, and we support both rails (SPT via `link-cli`, Tempo testnet via `mppx account create`). Primary demo rail: Tempo testnet (fully automatic, no card UI). Backup: SPT.

### 1.2 The demo: "Wildfire alert before the deadline"

One mission, three strategies, real computation, one judge-driven disruption, one surprise.

**Setup (shown on the globe):**
- `SAT-A` (imaging, operator "Heliostat Imaging"): has a fresh 180 MB multispectral scene of an active wildfire. Weak onboard CPU. Own ground pass in 19 sim-minutes.
- `SAT-B` (compute, operator "Orbital Foundry"): spare accelerator, sells inference by the second, capped by a power budget. Crosslink window with A: 90 s.
- `SAT-C` (relay, operator "Kepler-style Relay Co"): sells downlink bytes during a ground contact in 5 sim-minutes.
- `SAT-D` (second relay, different operator): appears later.
- Buyer: an emergency-response agent. "Deliver a wildfire assessment within 8 minutes for under $6."

**Act 1 — Impossible alone.** Dashboard shows SAT-A's own downlink is at T+19 min. Deadline is T+8. Mission infeasible under single-operator.

**Act 2 — The agent assembles a path.** Buyer calls the Manufact MCP server → discovers B and C → gets quotes → the planner (deterministic, time-expanded graph) returns three candidate plans:

| Plan | Delivery | Cost | Feasible |
|------|----------|------|----------|
| Own downlink | T+19 | $0 | ✗ deadline |
| Raw relay via C (180 MB) | — | $3.60 | ✗ 180 MB does not fit the 40 s crosslink |
| Inference on B → 40 KB result via C | T+5.2 | $3.50 | ✓ |

The agent reserves B and C. Each reservation is an MPP 402 → pay → receipt. Each provider returns a **signed resource grant** (JWT-style, Ed25519, scoped: capability, max input bytes, max compute seconds, window ID, expiry in sim time, max charge). Stripe Dashboard shows two payments appear.

**Act 3 — Real execution.** The sim opens the A→B window; the network emulator moves the actual image bytes at the window's bandwidth (progress bar on the link). SAT-B's InstaBox verifies the grant signature and scope, runs real inference (CPU ONNX/threshold model on a real Landsat/Sentinel fire scene), produces a GeoJSON of fire polygons + confidence + a thumbnail (~40 KB). B's power budget visibly drops.

**Act 4 — The judge breaks it.** From the phone control panel the judge either (a) revokes C's remaining relay capacity, or (b) submits a competing high-priority mission that eats B's accelerator. The broker replans: committed/paid work is preserved (B's inference result is already produced and stays), the uncommitted leg is renegotiated. If no feasible path exists, it says so honestly and the mission is marked INFEASIBLE with the reason.

**Act 5 — The surprise.** Operator D spins up a new InstaBox from the relay snapshot. It registers itself with the marketplace with a brand-new key and a slightly different capability manifest. The buyer agent discovers it mid-mission, verifies its manifest, pays it, and the result reaches the ground station at T+6.8. Receipt, signatures, bytes, and timing are in the audit log.

**Why this beats a "routing animation":** three different kinds of enforcement are visibly real — physics (bytes can't move outside a window), policy (grant signature + scope checked on a separate machine), and money (real MPP transactions). And the LLM is only used where interpretation is needed: parsing the mission, choosing among planner outputs, and onboarding a never-seen provider manifest.

---

## 2. Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │  Judge's Claude Desktop / Cursor (optional)  │
                    └───────────────┬──────────────────────────────┘
                                    │ MCP
 ┌─────────────────┐   MCP   ┌──────▼──────────────────────────────┐
 │  Buyer Agent    ├────────►│  OrbitalNet Marketplace MCP server   │  ← Manufact Cloud
 │  (Claude via    │         │  (TypeScript, mcp-use v2)            │
 │   Anthropic SDK,│         │  registry · quotes · planner proxy   │
 │   mppx client)  │         │  reservations · mission ledger       │
 └───────┬─────────┘         └──────┬───────────────┬──────────────┘
         │ MPP 402/pay               │ HTTP          │ HTTP
         │                           │               │
 ┌───────▼───────────┐     ┌─────────▼─────┐  ┌──────▼─────────────┐
 │ Operator services │     │ Sim + Planner │  │ Stripe sandbox     │
 │ (one per InstaBox)│◄───►│ (Python,      │  │ (PaymentIntents    │
 │  SAT-B compute    │ WS  │  FastAPI)     │  │  via mppx)         │
 │  SAT-C relay      │     │  Skyfield/SGP4│  └────────────────────┘
 │  SAT-D relay (new)│     │  windows,     │
 │  key + policy +   │     │  net emulator,│  ┌────────────────────┐
 │  MPP endpoints    │     │  scheduler    ├─►│ Dashboard (React,  │
 └───────────────────┘     └───────────────┘  │ 3D globe, feed,    │
                                              │ judge panel)       │
                                              └────────────────────┘
```

### 2.1 Components

| Component | Tech | Owner | Notes |
|-----------|------|-------|-------|
| `sim/` orbital + network emulator + planner | Python 3.12, FastAPI, Skyfield (real TLEs from CelesTrak for visual credibility), asyncio, WebSocket event bus | Dev 1 | Sim clock is accelerated (e.g. 20×). Contact windows precomputed from geometry at a fixed epoch chosen so the story works; stored as JSON so the demo is deterministic. Crosslink needs range < threshold AND compatible-terminal flag. Transfers only progress while a window is open; bandwidth × time caps bytes. |
| `sim/planner` | Time-expanded graph search (custom; OR-Tools CP-SAT optional) | Dev 1 | Input: mission (bytes, deadline, budget, required output), provider quotes, windows. Output: ranked feasible plans with cost/latency and the exact windows used. Pure function → unit-testable. |
| `operators/` provider service | TypeScript, Hono, `mppx/server`, `@noble/ed25519`, SQLite ledger | Dev 2 | One codebase, three configs (compute/relay/relay-2). Endpoints below. Deployed to InstaBox (Dockerfile + snapshot). |
| `operators/inference` | Python ONNX Runtime or NumPy band-threshold on a real fire scene | Dev 1 | Must produce a real, small result from a real large input. |
| `marketplace/` MCP server | TypeScript, mcp-use v2, zod schemas, MCP Apps widget for mission status | Dev 2 | Deployed to Manufact. Also runnable locally for dev. |
| `buyer/` agent | TypeScript, Anthropic SDK (`claude-fable-5-1`), MCP client to Manufact URL, `mppx/client` | Dev 2 | System prompt holds mission policy; tool calls do the work; planner picks feasibility, LLM picks among feasible options and explains. |
| `dashboard/` | React + Vite, `react-globe.gl` (three.js) for orbits/links, Tailwind, WebSocket | Dev 1 | Panels: globe, mission timeline, plan comparison table, event/audit feed, Stripe ticker, provider cards (capacity/power/price), judge panel (phone route `/judge`). |
| `bench/` | Python scripts | Dev 1 (late) | 50 seeded scenarios × 3 strategies; outputs CSV + one chart for a secondary screen. |

### 2.2 Operator service API (every provider speaks this; manifest is self-describing)

| Endpoint | Auth/Pay | Purpose |
|----------|----------|---------|
| `GET /.well-known/orbitalnet.json` | none | Signed capability manifest: operator ID, public key, node ID, capabilities (`image-inference`, `relay`), models, max input MB, power budget, base price, scarcity α, policy flags. |
| `POST /quote` | none | Price for (capability, bytes/seconds, window ID). `p = p0 + α·d/max(c,ε)`, bounded by policy. Recomputed on every capacity change. |
| `POST /reserve` | **MPP 402** | Commits capacity for a window; returns receipt + **signed grant**. |
| `POST /execute` | grant | Compute node: verifies signature, scope, expiry, bytes; runs inference; returns result + usage. |
| `POST /transmit` | grant | Relay node: verifies grant; accepts bytes only inside the window; emits progress. |
| `POST /admin/revoke`, `/admin/capacity` | operator key | Judge/phone controls. Revocation never cancels a paid, already-executed grant. |

Grant payload (Ed25519-signed by the provider):
```json
{"grant_id":"g_…","mission_id":"fire-001","provider":"orbital-foundry","node":"SAT-B",
 "capability":"image-inference","model":"fire-detector-v1","max_input_mb":200,
 "max_compute_s":60,"window_id":"w_AB_1","expires_sim_t":480,"max_charge_usd":2.00,
 "receipt_id":"mpp_rcpt_…"}
```

### 2.3 Marketplace MCP tools (Manufact)

| Tool | What it does |
|------|--------------|
| `discover_providers` | Lists registered operators + manifests (filter by capability, window overlap). |
| `get_contact_windows` | Windows between nodes / ground stations from the sim. |
| `request_quotes` | Fans out `/quote` to providers for a candidate plan. |
| `plan_mission` | Calls the planner; returns ranked feasible plans with explanations. |
| `reserve_path` | Executes MPP payments + collects grants for one plan. Atomic-ish: on failure, unpaid legs are released. |
| `submit_mission` | Kicks off execution in the sim. |
| `get_mission_status` | Timeline, bytes moved, grants, receipts, result. Rendered as an MCP App widget. |
| `inject_disruption` | Judge-only: revoke capacity, add competing mission, kill a link, register new provider. |

### 2.4 Honesty boundaries (say these in the pitch)
- Orbits are real SGP4 propagation of real TLEs; link compatibility, bandwidth, power, and windows are **modeled**.
- Payment happens through a **ground-connected broker before** the window; the grant is verified **offline** at execution. We never claim on-orbit atomic settlement.
- Prior art acknowledged: ION-DTN, EDRS/SpaceDataHighway, Kepler, EarthSight. Our contribution is the provider-neutral **negotiation + conditional contracts + recovery** layer, not satellite networking.

---

## 3. Build order (shippable at every checkpoint)

| Phase | Hours | Dev 1 (sim/planner/dashboard) | Dev 2 (operators/MCP/payments/agent) | Checkpoint |
|-------|-------|-------------------------------|--------------------------------------|------------|
| 0 Prep (before hack) | 2 | Pick TLEs + epoch, download fire scene, verify Skyfield windows look good | Stripe sandbox profile + Tempo deposit addr, `mppx validate` passes on hello-world; Manufact hello-world deployed; InstaBox box created with public port | All accounts + hello-worlds green |
| 1 Core relay brokerage | 4 | Sim clock, windows, byte-accurate transfer emulator, event bus, globe showing orbits + windows | Operator service with manifest/quote/reserve(MPP)/transmit + grants; MCP server with discover/quotes/reserve/submit/status | Buyer buys a relay and real bytes reach ground inside a window; payment in Stripe Dashboard |
| 2 Compute leg + planner | 4 | Time-expanded planner with 3-plan comparison; inference worker | Compute operator on InstaBox; buyer agent loop with Claude choosing among plans | Full Act 1–3 works end to end |
| 3 Disruption + recovery | 3 | Replan preserving committed grants; infeasible path reported correctly | Judge phone panel; `inject_disruption`; competing mission pricing | Act 4 works, functional tests pass |
| 4 Surprise provider | 2 | — | InstaBox snapshot → new box → self-register → buyer onboards from manifest only | Act 5 works |
| 5 Polish + proof | 3 | Globe polish, audit feed, bench script + chart | Armature instrumentation (if time), Manufact MCP App widget, README, pitch | Demo rehearsed 3× |

### Functional tests (must all pass; shown on secondary screen)
Link closed → no bytes move · Window too small → transfer rejected/deferred · Bad grant signature → execute refused · Expired grant → refused · Price change → replan · Compute node revoked after result → result preserved, relay renegotiated · No feasible path → INFEASIBLE with reason · Happy path → result + receipts + audit.

### Benchmark (secondary screen, labeled "preliminary simulation")
50 seeded scenarios × {single-operator, fixed-contract, OrbitalNet}. Report deadline-hit rate, median/p95 latency, cost per success, unauthorized requests rejected. The B-vs-C comparison is the one that matters.

---

## 4. Pre-hackathon checklist (you)
- [ ] Stripe: sandbox `sk_test_…`, Business Profile `profile_test_…`, Tempo deposit address (`network=tempo`), `npm i -g @stripe/cli`, `npx @stripe/link-cli auth login`.
- [ ] `npx mppx@latest account create` (Tempo testnet buyer wallet), fund it.
- [ ] Manufact account; `npx -y mcp-use@latest login`.
- [ ] InstaBox account + API key; confirm box-count limit (demo showed 5) and that a public port URL works.
- [ ] Anthropic API key.
- [ ] Confirm sponsor track names/rules with organizers (Manufact vs "Manifek", InstaBox vs "Insparge").
- [ ] Download: 3–5 TLEs from CelesTrak (e.g. Sentinel-2A, a Planet Dove, Landsat 9, two Starlink/Kepler-class for relays), one Landsat/Sentinel fire scene (GeoTIFF or JPEG).

## 5. Pitch line
> OrbitalNet lets independently operated satellites discover, negotiate, and securely buy temporary compute and relay capacity from each other through an open MCP marketplace — turning missions that are impossible for one spacecraft into deadline-feasible, paid, auditable multi-operator plans, and recovering when the network changes.
