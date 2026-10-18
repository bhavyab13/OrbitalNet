# OrbitalNet Capacity Grant Protocol (OCGP) — v0.1

**Status:** Draft, implemented in this repo. Transport: HTTPS + MCP. Payments: MPP (Stripe / Tempo). Signatures: Ed25519.

## 0. The problem that existing agent protocols do not solve

MPP and x402 let an agent pay for a resource **that is served in the same request**: 402 → pay → resource → receipt. That assumes the resource exists *now*, on a machine that can *verify the payment now*.

Orbital infrastructure breaks both assumptions:

1. The resource is a **future contact window**: 90 seconds of crosslink bandwidth starting in 6 minutes, or 45 seconds of accelerator time while two spacecraft are in view. It cannot be delivered when it is paid for.
2. The machine that fulfils the resource (a satellite) will typically have **no connectivity to the payment network at fulfilment time**. It cannot re-check a receipt.
3. A single purchase is useless alone. A mission needs a **chain** of resources from *different owners* (compute on one operator's spacecraft, relay on another's). Paying for a compute lease that has no deadline-feasible relay behind it is wasted money. The buyer needs *conditional, all-or-nothing* commitment across owners.
4. The world changes between payment and fulfilment (a link drops, a competing mission takes capacity). The protocol must say what survives: which commitments are preserved, which are released, who is refunded.
5. Providers come and go. A provider the buyer has never seen must be usable **without integration code**: its interface must be self-describing to an agent.

OCGP is the layer on top of MPP that handles 1–5. It is a protocol for **buying time-windowed, policy-scoped capability on infrastructure you don't control, that may be offline when you use it.**

## 1. Roles

| Role | Who | Keys |
|------|-----|------|
| **Provider** | An independently operated node (compute or relay). Runs the Operator Service. | Ed25519 operator key. MPP recipient (Tempo address or Stripe profile). |
| **Buyer** | An agent acting for a mission owner. | MPP payer wallet (Tempo testnet or Stripe SPT). |
| **Broker** | The marketplace MCP server. Registry + planner proxy + reservation orchestrator. Does **not** hold authority over providers. | Ed25519 broker key (signs plan commitments only). |
| **World** | The physics authority (orbital sim). Issues signed time/window assertions. In reality this is the spacecraft's own GNC/contact schedule. | Ed25519 world key. |

Providers trust only (a) their own signature on grants they issued and (b) the World key for time/window facts. They never trust the broker or the buyer.

## 2. Messages

All messages are JSON. Signed messages carry `sig` = base64url(Ed25519(canonical_json(message_without_sig))) and `kid` = signer key id. Canonical JSON = keys sorted, no whitespace, UTF-8.

### 2.1 Manifest (Provider → world, at `GET /.well-known/ocgp.json`)
Self-describing, signed. An agent can onboard from this alone.
```json
{
  "ocgp": "0.1",
  "operator_id": "orbital-foundry",
  "operator_name": "Orbital Foundry",
  "node_id": "PHISAT-2",
  "public_key": "base64url-ed25519",
  "kid": "of-2026-10",
  "base_url": "https://…",
  "capabilities": [
    {"type": "compute", "models": ["fire-detector-v1"], "max_input_mb": 400,
     "max_compute_s": 120, "power_budget_wh": 100, "price_base_usd": 1.50,
     "price_per_compute_s": 0.02, "scarcity_alpha": 0.8},
    {"type": "relay", "max_payload_mb": 500, "price_per_mb": 0.02, "price_min_usd": 0.50,
     "scarcity_alpha": 0.5}
  ],
  "policy": {"allowed_ops": ["image-inference"], "deny_arbitrary_code": true,
             "max_grant_ttl_s": 1800, "refund_on_provider_outage": true},
  "payment": {"protocol": "mpp", "methods": ["tempo", "spt"], "currency": "USD"},
  "sig": "…"
}
```

### 2.2 Quote (Provider → Buyer/Broker, `POST /quote`)
Bound to a specific window and amount of capacity. Expires. Price follows the provider's scarcity rule `p = p0 + α·d/max(c,ε)`, bounded by policy.
```json
{"quote_id":"q_…","operator_id":"…","node_id":"…","capability":"relay",
 "window_id":"w_C_GS_1","window":{"start":300,"end":360,"bandwidth_mbps":50},
 "units":{"mb":0.04},"price_usd":0.50,"available_capacity":{"mb":375},
 "expires_sim_t":200,"sig":"…"}
```

### 2.3 Hold (optional, `POST /hold`) — unpaid, short TTL (default 60 sim-s). Lets the broker check an entire multi-owner path is feasible before any money moves. Expired holds release automatically. This is the **two-phase commit across owners**.

### 2.4 Grant (Provider → Buyer, returned by `POST /reserve` after MPP payment)
The core object. A bearer capability, scoped and time-boxed, signed by the provider, **bound to the MPP receipt**. Verifiable offline by the provider's own node.
```json
{
  "grant_id": "g_…", "mission_id": "fire-001",
  "operator_id": "orbital-foundry", "node_id": "PHISAT-2",
  "capability": "compute", "op": "image-inference", "model": "fire-detector-v1",
  "window_id": "w_A_B_1", "window": {"start": 60, "end": 150},
  "limits": {"max_input_mb": 200, "max_compute_s": 60, "max_output_mb": 1},
  "valid_sim_t": {"not_before": 0, "not_after": 480},
  "price_usd": 1.90,
  "payment": {"protocol": "mpp", "method": "tempo", "receipt_ref": "0xtxhash…", "receipt": {…}},
  "holder": "buyer:emergency-ops",
  "issued_at": "2026-10-18T…Z", "kid": "of-2026-10", "sig": "…"
}
```
Rules: a grant can only be **fulfilled** on the node it names, inside its window, for ≤ its limits, before `not_after`. A grant is **single-use**. A provider may **revoke** a grant only if it has not been fulfilled; revocation of a *paid* grant obliges a Refund Voucher.

### 2.5 World Assertion (World → anyone, attached to fulfilment requests)
```json
{"sim_t": 72, "window_id": "w_A_B_1", "open": true, "link": ["SENTINEL-2A","PHISAT-2"],
 "bandwidth_mbps": 100, "issued_at": "…", "kid": "world", "sig": "…"}
```
Providers verify this to decide whether a grant's window is actually open. No assertion, no fulfilment — physics is enforced by signature, not by trust in the caller.

### 2.6 Fulfilment request (Buyer/World-runner → Provider, `POST /execute` or `POST /transmit`)
`{grant, world_assertion, payload (bytes or URL), params}`. Provider verifies: grant sig (own key) → not revoked, not used → world sig → window matches → sim_t in range → payload ≤ limits → op ∈ policy. Any failure → `403 ocgp/grant-rejected` with a machine-readable reason. Then executes.

### 2.7 Usage Attestation (Provider → Buyer, returned on success)
```json
{"attestation_id":"a_…","grant_id":"g_…","mission_id":"fire-001","node_id":"PHISAT-2",
 "op":"image-inference","input_bytes":188743680,"output_bytes":41210,"compute_s":38.2,
 "power_wh":28.4,"result_sha256":"…","sim_t_start":74,"sim_t_end":112,"kid":"…","sig":"…"}
```
The attestation + receipt + grant form the **audit triple**: *what was paid, what was authorised, what was done*. Reconciliation = checking the three agree.

### 2.8 Refund Voucher (Provider → Buyer) — issued when a paid grant becomes unfulfillable because of the provider's side (link outage, capacity revoked). Signed credit redeemable at that provider. (In this implementation: ledger credit + event; real money movement would use Stripe refunds when the Stripe rail is active.)

## 3. Plans and conditional commitment

A **Plan** is an ordered list of legs, each `{node_from, node_to, window_id, grant?}` or `{node, op, window_id, grant?}`. The broker's planner only returns plans that are *physically* feasible (bytes fit windows, compute fits window, finish ≤ deadline) and *economically* feasible (Σ quotes ≤ budget). The buyer chooses among feasible plans (the LLM's job: trade latency vs cost vs output fidelity).

Commitment is **conditional**: the broker places Holds on every leg, and only if all holds succeed does it pay (MPP) each provider and collect Grants. If any leg's hold fails, no money moves. This is what makes cross-owner purchase safe.

## 4. Replanning rules (what survives a disruption)

Two failure events are deliberately different, and a credible protocol must handle both:

| Event | When | What OCGP does | Money moved |
|-------|------|----------------|-------------|
| **E1 — provider withdraws before commit** | During PREPARE (holds placed, nothing paid) | The hold fails → all other holds are released → no `/reserve` is called → the compute job is never submitted | **$0** |
| **E2 — provider fails after work started** | During EXECUTE (compute done, relay window killed) | Fulfilled grants are final: the result is preserved at the node that holds it; the unfulfilled paid grant is refunded by voucher; replan from the current state | Only fulfilled work is paid |


1. **Fulfilled grants are final.** Their attestations and results are preserved; a replan starts from the node that holds the latest result.
2. **Unfulfilled paid grants on a working provider stay valid** until `not_after`. A replan may reuse them.
3. **Unfulfilled paid grants on a failed provider** → provider issues a Refund Voucher; buyer's budget is restored by that amount.
4. **Unpaid holds are released.**
5. If no feasible plan exists from the current state, the mission is declared `INFEASIBLE` with the reason (e.g. "no path to any ground station before deadline"). The protocol never fabricates delivery.

## 5. Discovery and zero-integration onboarding

Providers register their manifest URL with the broker (`POST /registry`), or the broker crawls `/.well-known/ocgp.json`. Because manifests are self-describing and signed, and all providers speak the same five endpoints (`/quote /hold /reserve /execute|/transmit /attest`), a buyer agent can use a provider it has never seen: no SDK, no custom adapter. In the demo, a brand-new relay provider boots from a snapshot, registers itself, and is contracted within the same mission.

## 6. Relationship to prior work (say this honestly)

- **MPP / x402**: synchronous pay-per-request. OCGP uses MPP for the money and adds deferred, offline-verifiable, scoped grants bound to receipts.
- **OAuth / macaroons / biscuit**: scoped bearer tokens. OCGP grants are similar in spirit but bound to a payment receipt and a physical contact window, and paired with a usage attestation.
- **DTN / ION, EDRS, Kepler**: real delay-tolerant networking and relay. OCGP does not do networking; it does negotiation, authorisation, and settlement *above* such links.
- **IETF DTN Peering Protocol draft (July 2026)**: inter-domain route discovery, time-dependent reachability and operator identity verification between DTN domains. It defines no economic reservations and no conditional purchase of compute together with communications. OCGP is the transactional service layer that would sit on top of DPP-style peering.
- **Blockchain satellite task-offloading papers (2025)**: economic incentives for offloading, but no window-bound, offline-verifiable grants and no cross-owner conditional commitment with a defined partial-failure model.
- **Satellite scheduling research (EarthSight etc.)**: centralised optimisation with full knowledge. OCGP is for *independent* owners with private policies, where no central optimiser can be trusted with everyone's state.

What is new is the combination: payment-bound, window-bound, offline-verifiable capability grants + conditional cross-owner commitment + explicit disruption semantics + self-describing onboarding, in a form an autonomous agent can drive through MCP.
