# OrbitalNet — 3-minute demo script

## The one-sentence claim
> Agents can now pay for things (MPP). OrbitalNet is the protocol that lets an agent pay for something that **doesn't exist yet, on a machine it can't reach when it uses it, from an owner it has never met** — and still have physics, policy and money all enforced in code.

## Why this needed agents (say this early)
Satellite relay and orbital compute already exist (EDRS, Kepler, Φsat-2). What never existed is a **provider-neutral negotiation layer**: each operator has private policy, private capacity, private prices; no central scheduler is trusted with all of it. The buyer must *discover, negotiate, conditionally commit, pay, and recover* across owners in seconds, inside contact windows. That's an agent-to-infrastructure protocol problem, not an orbital-mechanics problem.

## What's real vs modeled (say this once, proudly)
- Real: spacecraft (Sentinel-2A, Φsat-2, EDRS-C, Starlink) propagated with SGP4 from today's TLEs; today's VIIRS fire detections over Papua (3,812 hotspots); the NASA imagery; the inference; Ed25519 signatures; MPP 402 challenges and Tempo/Stripe receipts; independent machines (InstaBox).
- Modeled: contact windows, bandwidths, power budgets, prices.

## Run of show
| T | Screen | Say |
|---|--------|-----|
| 0:00 | Globe, story mode on. Fires glowing over Papua. | "This morning VIIRS saw 3,800 fire detections over Papua. Sentinel-2A just imaged it. Responders need a perimeter in 12 minutes." |
| 0:20 | Mission HUD: own downlink T+27 min. Plan table shows ✗ ✗ ✓. | "Alone, the spacecraft fails: its next ground pass is after the deadline. Raw relay fails too: 180 MB doesn't fit a 40-second crosslink. The only path is: compute on **someone else's** satellite, relay through a **third** operator's link." |
| 0:40 | JUDGE presses "E1: Lumen Relay withdraws capacity at commit" **before** the agent reserves. Broker narration: hold refused, releasing, no money moved. | "First failure mode: a provider pulls out between quote and commit. Because commitment is conditional, the compute hold is released and zero dollars move. The agent simply replans." |
| 0:55 | Buyer narration + payment ticker: two MPP payments, two signed grants. | "The agent read each provider's signed manifest, got window-bound quotes, placed holds on both legs, and only then paid — conditional commitment across two owners. Each grant is a bearer capability bound to the receipt and to a contact window." |
| 1:10 | Link A→B lights, bytes flow, Φsat-2 runs inference, power bar drops, result overlay thumbnail. | "The compute satellite verifies the grant **offline**: its own signature, the world's signed time assertion, scope, bytes. Then real inference on the real scene." |
| 1:40 | JUDGE presses "Ground station outage" on the phone. Link C→GS turns red. Refund event. | "A judge just killed the relay's downlink. Watch what survives: the compute result is committed and preserved; the unfulfilled relay grant is refunded with a signed voucher; the agent replans from Φsat-2." |
| 2:00 | Plan table: INFEASIBLE… then JUDGE presses "New provider online". InstaBox console shows a box booting; new provider card animates in; agent discovers, pays, re-routes via Starlink → Oregon. | "No path exists — until a provider the agent has never seen boots from a snapshot and publishes its manifest. Zero integration code. Discovered, verified, paid, used, in one mission." |
| 2:40 | DELIVERED. Audit triple: receipt ↔ grant ↔ attestation. | "Delivered at T+7:16 for $3.40. Every dollar matches a grant matches an attestation. That reconciliation is the protocol." |
| 2:55 | Optional: Claude Desktop with the Manufact connector, MCP App widget. | "And any agent can do this — here's Claude Desktop driving it through our Manufact-hosted MCP server." |

## If something breaks
- Buyer stalls → run deterministic mode: `npm run buyer -- --auto`.
- Payments fail → `PAY_RAIL=mock` in `.env`, restart operators (say "mock rail" out loud; the 402 flow is identical).
- Sim dies → `POST /reset`; dashboard reconnects automatically. Mock replay: `VITE_MOCK=1 npm run dev` in `dashboard/`.
