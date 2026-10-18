/**
 * Mock replay: a scripted OCGP mission derived from data/scenario.json + expected_story.
 * Drives the same store reducer as the live WS, so the UI is identical.
 */
import { useStore } from '../store'
import scenarioJson from './scenario.json'
import hotspots from './hotspots.json'
import { allPositions } from './positions'
import type { Hotspot, Plan, Scenario, SimEvent } from '../types'

const scenario = scenarioJson as unknown as Scenario
const M = scenario.mission

const ref = (seed: string) => '0x' + Array.from({ length: 64 }, (_, i) => ((seed.charCodeAt(i % seed.length) * (i + 7) * 2654435761) >>> 0).toString(16).slice(-1)).join('')

const PLANS: Plan[] = [
  {
    plan_id: 'p_own', label: 'Own downlink (SENTINEL-2A → Svalbard)', feasible: false,
    delivery_sim_t: 1620, cost_usd: 0, reasons: ['Delivery T+1620s is after deadline T+720s'],
    legs: [{ kind: 'transfer', from: 'SENTINEL-2A', to: 'GS-SVALBARD', window_id: 'w_A_GS_own', start: 1500, end: 1504.8, bytes_mb: 180, price_usd: 0 }],
  },
  {
    plan_id: 'p_raw_c', label: 'Raw relay via EDRS-C (180 MB)', feasible: false,
    delivery_sim_t: null, cost_usd: 9.1, reasons: ['180 MB does not fit w_A_C_1 (40 s × 25 Mbps = 125 MB)', '$9.10 exceeds budget $6.00'],
    legs: [
      { kind: 'transfer', from: 'SENTINEL-2A', to: 'EDRS-C', window_id: 'w_A_C_1', start: 40, end: 97.6, bytes_mb: 180, price_usd: 3.6 },
      { kind: 'transfer', from: 'EDRS-C', to: 'GS-PUNTA-ARENAS', window_id: 'w_C_GS_1', start: 300, end: 328.8, bytes_mb: 180, price_usd: 5.5 },
    ],
  },
  {
    plan_id: 'p_b_c', label: 'Inference on PHISAT-2 → relay EDRS-C → Punta Arenas', feasible: true,
    delivery_sim_t: 312, cost_usd: 2.45, reasons: [],
    legs: [
      { kind: 'transfer', from: 'SENTINEL-2A', to: 'PHISAT-2', window_id: 'w_A_B_1', start: 60, end: 74.4, bytes_mb: 180, price_usd: 0 },
      { kind: 'compute', node: 'PHISAT-2', window_id: 'w_A_B_1', start: 74.4, end: 119.4, duration_s: 45, price_usd: 1.95, quote_id: 'q_b1' },
      { kind: 'transfer', from: 'PHISAT-2', to: 'EDRS-C', window_id: 'w_B_C_1', start: 200, end: 200.02, bytes_mb: 0.04, price_usd: 0 },
      { kind: 'transfer', from: 'EDRS-C', to: 'GS-PUNTA-ARENAS', window_id: 'w_C_GS_1', start: 300, end: 300.01, bytes_mb: 0.04, price_usd: 0.5, quote_id: 'q_c1' },
    ],
  },
  {
    plan_id: 'p_b_own', label: 'Inference on PHISAT-2 → PHISAT-2 own pass (Singapore)', feasible: false,
    delivery_sim_t: 960, cost_usd: 1.95, reasons: ['Delivery T+960s is after deadline T+720s'],
    legs: [
      { kind: 'transfer', from: 'SENTINEL-2A', to: 'PHISAT-2', window_id: 'w_A_B_1', start: 60, end: 74.4, bytes_mb: 180, price_usd: 0 },
      { kind: 'compute', node: 'PHISAT-2', start: 74.4, end: 119.4, duration_s: 45, price_usd: 1.95 },
      { kind: 'transfer', from: 'PHISAT-2', to: 'GS-SINGAPORE', window_id: 'w_B_GS_1', start: 900, end: 900.01, bytes_mb: 0.04, price_usd: 0 },
    ],
  },
]

const REPLAN: Plan[] = [
  {
    plan_id: 'p_b_d', label: 'Preserve result on PHISAT-2 → relay STARLINK-3005 → Oregon', feasible: true,
    delivery_sim_t: 436, cost_usd: 0.5, reasons: [],
    legs: [
      { kind: 'transfer', from: 'PHISAT-2', to: 'STARLINK-3005', window_id: 'w_B_D_1', start: 380, end: 380.01, bytes_mb: 0.04, price_usd: 0 },
      { kind: 'transfer', from: 'STARLINK-3005', to: 'GS-OREGON', window_id: 'w_D_GS_1', start: 430, end: 430.01, bytes_mb: 0.04, price_usd: 0.5, quote_id: 'q_d1' },
    ],
  },
  {
    plan_id: 'p_b_own2', label: 'PHISAT-2 own pass (Singapore)', feasible: false, delivery_sim_t: 960, cost_usd: 0,
    reasons: ['Delivery T+960s is after deadline T+720s'],
    legs: [{ kind: 'transfer', from: 'PHISAT-2', to: 'GS-SINGAPORE', window_id: 'w_B_GS_1', start: 900, end: 900.01, bytes_mb: 0.04, price_usd: 0 }],
  },
]

// Fake result: cluster the hotspots into a few fire polygons (bbox-based) for the overlay.
function buildResult() {
  const pts = (hotspots as Hotspot[]).filter((h) => h.conf !== 'low')
  const cells: Record<string, Hotspot[]> = {}
  for (const h of pts) {
    const k = `${Math.floor(h.lat * 2.5)}_${Math.floor(h.lon * 2.5)}`
    ;(cells[k] ??= []).push(h)
  }
  const features = Object.values(cells)
    .filter((c) => c.length >= 14)
    .sort((a, b) => b.length - a.length)
    .slice(0, 12)
    .map((c, i) => {
      const lats = c.map((p) => p.lat), lons = c.map((p) => p.lon)
      const [a, b, cc, d] = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
      return {
        type: 'Feature',
        properties: { id: `front-${i + 1}`, detections: c.length, frp_sum: Math.round(c.reduce((s, p) => s + p.frp, 0)), confidence: Math.min(0.99, 0.6 + c.length / 60) },
        geometry: { type: 'Polygon', coordinates: [[[a, b], [cc, b], [cc, d], [a, d], [a, b]]] },
      }
    })
  const pointFeatures = pts.slice(0, 300).map((h) => ({ type: 'Feature', properties: { frp: h.frp }, geometry: { type: 'Point', coordinates: [h.lon, h.lat] } }))
  return {
    geojson: { type: 'FeatureCollection', features: [...features, ...pointFeatures] },
    summary: { fire_pixels: 18342, clusters: features.length, active_fronts: features.length, max_frp_proxy: 412, bbox: M.scene.bbox, model: M.model, compute_s: 38.2, output_kb: 41.2 },
  }
}

type Step = { t: number; ev: SimEvent | (() => SimEvent) }

function script(): Step[] {
  const S: Step[] = []
  const say = (t: number, act: string, text: string) => S.push({ t, ev: { type: 'narration', act, text } })
  S.push({ t: 0, ev: { type: 'narration', act: 'Act 1 — A mission arrives', text: `Emergency ops requests: "${M.text}"` } })
  S.push({ t: 2, ev: { type: 'mission_created', mission_id: M.mission_id } })
  S.push({ t: 3, ev: { type: 'mcp_client_call', client: 'claude-desktop/1.0', tool: 'plan_mission' } })
  say(6, 'Act 1 — Impossible alone', 'SENTINEL-2A has the scene but cannot process it onboard (≈400 s on 0.3 TOPS) and its next ground pass over Svalbard is T+1500s — after the T+720s deadline.')
  S.push({ t: 10, ev: { type: 'plans', plans: PLANS.slice(0, 1) } })
  say(12, 'Act 2 — Discovery', 'Buyer agent calls discover_providers on the OrbitalNet marketplace. Two signed manifests verified: Orbital Foundry (PHISAT-2, compute) and Lumen Relay (EDRS-C, relay).')
  S.push({ t: 16, ev: { type: 'quote', node_id: 'PHISAT-2', price_usd: 1.95 } })
  S.push({ t: 17, ev: { type: 'quote', node_id: 'EDRS-C', price_usd: 0.5 } })
  say(18, 'Act 2 — Planning', 'Planner enumerates time-expanded paths. Raw relay fails physics (180 MB > 125 MB window) and budget. Remote inference turns 180 MB into 40 KB — the only deadline-feasible path.')
  S.push({ t: 20, ev: { type: 'plans', plans: PLANS } })
  S.push({ t: 24, ev: { type: 'plan_chosen', plan_id: 'p_b_c', plans: PLANS } })
  say(25, 'Act 2 — Conditional commitment', 'Holds placed on both legs. Only once every owner confirms does money move: two MPP payments, two signed Grants bound to receipts.')
  S.push({ t: 26, ev: { type: 'hold', node_id: 'PHISAT-2', window_id: 'w_A_B_1' } })
  S.push({ t: 27, ev: { type: 'hold', node_id: 'EDRS-C', window_id: 'w_C_GS_1' } })
  S.push({ t: 30, ev: { type: 'payment', operator_id: 'orbital-foundry', node_id: 'PHISAT-2', amount_usd: 1.95, method: 'tempo', receipt_ref: ref('b1'), description: 'compute lease w_A_B_1' } })
  S.push({ t: 31, ev: { type: 'grant_issued', grant: { grant_id: 'g_7f3a1c9e', node_id: 'PHISAT-2', capability: 'compute', window_id: 'w_A_B_1', price_usd: 1.95, valid_sim_t: { not_after: 480 }, payment: { receipt_ref: ref('b1') } } } })
  S.push({ t: 33, ev: { type: 'payment', operator_id: 'lumen-relay', node_id: 'EDRS-C', amount_usd: 0.5, method: 'tempo', receipt_ref: ref('c1'), description: 'relay w_C_GS_1' } })
  S.push({ t: 34, ev: { type: 'grant_issued', grant: { grant_id: 'g_b02e77d1', node_id: 'EDRS-C', capability: 'relay', window_id: 'w_C_GS_1', price_usd: 0.5, valid_sim_t: { not_after: 720 }, payment: { receipt_ref: ref('c1') } } } })
  S.push({ t: 36, ev: { type: 'mission_status', status: 'RUNNING', mission_id: M.mission_id, current_leg: 0 } })
  say(40, 'Act 3 — Real execution', 'Window w_A_B_1 opens at T+60s. The world moves bytes only while the link is physically open — 100 Mbps for 90 seconds.')
  // transfer A->B 60..74.4
  S.push({ t: 60, ev: { type: 'window_open', window_id: 'w_A_B_1' } })
  S.push({ t: 60, ev: { type: 'leg_start', leg_index: 0, kind: 'transfer', from: 'SENTINEL-2A', to: 'PHISAT-2', window_id: 'w_A_B_1' } })
  for (let i = 1; i <= 14; i++) S.push({ t: 60 + i, ev: { type: 'transfer_progress', window_id: 'w_A_B_1', from: 'SENTINEL-2A', to: 'PHISAT-2', bytes_moved_mb: Math.min(180, i * 12.5), bytes_total_mb: 180, pct: Math.min(100, (i * 12.5 * 100) / 180) } })
  S.push({ t: 75, ev: { type: 'transfer_progress', window_id: 'w_A_B_1', from: 'SENTINEL-2A', to: 'PHISAT-2', bytes_moved_mb: 180, bytes_total_mb: 180, pct: 100 } })
  S.push({ t: 75, ev: { type: 'leg_done', leg_index: 0, kind: 'transfer', window_id: 'w_A_B_1', attestation: { attestation_id: 'a_tr_01', node_id: 'PHISAT-2', op: 'receive', input_bytes: 188743680 } } })
  S.push({ t: 76, ev: { type: 'leg_start', leg_index: 1, kind: 'compute', node: 'PHISAT-2', op: 'image-inference' } })
  say(78, 'Act 3 — Grant verified offline', 'PHISAT-2 checks the Grant signature (its own key), the World Assertion (sim key), window, scope, byte limits — then runs fire-detector-v1 on the real VIIRS scene.')
  S.push({ t: 121, ev: { type: 'leg_done', leg_index: 1, kind: 'compute', node: 'PHISAT-2', power_budget_wh: 100, attestation: { attestation_id: 'a_c_7f3a', grant_id: 'g_7f3a1c9e', node_id: 'PHISAT-2', op: 'image-inference', input_bytes: 188743680, output_bytes: 41210, compute_s: 38.2, power_wh: 28.4 } } })
  S.push({ t: 122, ev: { type: 'result', result: buildResult() } })
  S.push({ t: 150, ev: { type: 'window_close', window_id: 'w_A_B_1' } })
  say(125, 'Act 3 — Attestation', 'A signed Usage Attestation returns: 180 MB in, 41 KB out, 38.2 s compute, 28.4 Wh. Paid, authorised, done — the audit triple agrees.')
  S.push({ t: 200, ev: { type: 'window_open', window_id: 'w_B_C_1' } })
  S.push({ t: 200, ev: { type: 'leg_start', leg_index: 2, kind: 'transfer', from: 'PHISAT-2', to: 'EDRS-C', window_id: 'w_B_C_1' } })
  S.push({ t: 201, ev: { type: 'transfer_progress', window_id: 'w_B_C_1', from: 'PHISAT-2', to: 'EDRS-C', bytes_moved_mb: 0.04, bytes_total_mb: 0.04, pct: 100 } })
  S.push({ t: 202, ev: { type: 'leg_done', leg_index: 2, kind: 'transfer', window_id: 'w_B_C_1', attestation: { attestation_id: 'a_tr_02', node_id: 'EDRS-C', op: 'receive', input_bytes: 41210 } } })
  S.push({ t: 260, ev: { type: 'window_close', window_id: 'w_B_C_1' } })
  say(265, 'Act 4 — The judge breaks it', 'Result is on EDRS-C, waiting for its Punta Arenas pass at T+300s…')
  S.push({ t: 280, ev: { type: 'link_killed', window_id: 'w_C_GS_1', reason: 'Ground station outage at Punta Arenas', label: 'judge: kill_c_downlink' } })
  S.push({ t: 281, ev: { type: 'replan_required', reason: 'w_C_GS_1 lost before fulfilment' } })
  S.push({ t: 282, ev: { type: 'mission_status', status: 'REPLAN_REQUIRED', mission_id: M.mission_id, committed: { node_id: 'PHISAT-2' } } })
  say(283, 'Act 4 — What survives', 'Fulfilled grant on PHISAT-2 is final: the result is preserved. The paid-but-unfulfilled relay grant on EDRS-C is refunded by voucher. No work is repeated.')
  S.push({ t: 285, ev: { type: 'refund', operator_id: 'lumen-relay', node_id: 'EDRS-C', amount_usd: 0.5, reason: 'provider-side outage (w_C_GS_1)' } })
  S.push({ t: 286, ev: { type: 'grant_revoked', grant_id: 'g_b02e77d1', node_id: 'EDRS-C', operator_id: 'lumen-relay', reason: 'unfulfillable — refunded' } })
  S.push({ t: 288, ev: { type: 'plans', plans: REPLAN.slice(1) } })
  say(290, 'Act 4 — No path', 'Replan from PHISAT-2: its only own pass is T+900s. Right now there is no deadline-feasible path. The protocol will say INFEASIBLE rather than invent a delivery…')
  say(300, 'Act 5 — A stranger joins', 'Judge launches a brand-new provider. Northstar Relay boots from a snapshot, generates its key, publishes a signed manifest at /.well-known/ocgp.json and registers itself.')
  S.push({ t: 304, ev: { type: 'provider_online', node_id: 'STARLINK-3005', operator_id: 'northstar-relay', operator_name: 'Northstar Relay', late: true, base_url: 'https://7003-agqu6xuufihmjk27jkjrx2n4ia.instabox.tech', manifest_url: 'https://7003-agqu6xuufihmjk27jkjrx2n4ia.instabox.tech/.well-known/ocgp.json' } })
  say(308, 'Act 5 — Zero-integration onboarding', 'The buyer has never seen Northstar. From the manifest alone it quotes, holds, pays and receives a Grant — no SDK, no adapter.')
  S.push({ t: 310, ev: { type: 'quote', node_id: 'STARLINK-3005', price_usd: 0.5 } })
  S.push({ t: 312, ev: { type: 'plans', plans: REPLAN } })
  S.push({ t: 315, ev: { type: 'plan_chosen', plan_id: 'p_b_d', plans: REPLAN } })
  S.push({ t: 317, ev: { type: 'hold', node_id: 'STARLINK-3005', window_id: 'w_D_GS_1' } })
  S.push({ t: 319, ev: { type: 'payment', operator_id: 'northstar-relay', node_id: 'STARLINK-3005', amount_usd: 0.5, method: 'tempo', receipt_ref: ref('d1'), description: 'relay w_D_GS_1' } })
  S.push({ t: 320, ev: { type: 'grant_issued', grant: { grant_id: 'g_e51c0a3b', node_id: 'STARLINK-3005', capability: 'relay', window_id: 'w_D_GS_1', price_usd: 0.5, valid_sim_t: { not_after: 720 }, payment: { receipt_ref: ref('d1') } } } })
  S.push({ t: 322, ev: { type: 'mission_status', status: 'RUNNING', mission_id: M.mission_id, current_leg: 0, committed: { node_id: 'PHISAT-2' } } })
  S.push({ t: 380, ev: { type: 'window_open', window_id: 'w_B_D_1' } })
  S.push({ t: 380, ev: { type: 'leg_start', leg_index: 0, kind: 'transfer', from: 'PHISAT-2', to: 'STARLINK-3005', window_id: 'w_B_D_1' } })
  S.push({ t: 381, ev: { type: 'transfer_progress', window_id: 'w_B_D_1', from: 'PHISAT-2', to: 'STARLINK-3005', bytes_moved_mb: 0.04, bytes_total_mb: 0.04, pct: 100 } })
  S.push({ t: 382, ev: { type: 'leg_done', leg_index: 0, kind: 'transfer', window_id: 'w_B_D_1', attestation: { attestation_id: 'a_tr_03', node_id: 'STARLINK-3005', op: 'receive', input_bytes: 41210 } } })
  S.push({ t: 420, ev: { type: 'window_close', window_id: 'w_B_D_1' } })
  S.push({ t: 430, ev: { type: 'window_open', window_id: 'w_D_GS_1' } })
  S.push({ t: 430, ev: { type: 'leg_start', leg_index: 1, kind: 'transfer', from: 'STARLINK-3005', to: 'GS-OREGON', window_id: 'w_D_GS_1' } })
  S.push({ t: 432, ev: { type: 'transfer_progress', window_id: 'w_D_GS_1', from: 'STARLINK-3005', to: 'GS-OREGON', bytes_moved_mb: 0.04, bytes_total_mb: 0.04, pct: 100 } })
  S.push({ t: 434, ev: { type: 'leg_done', leg_index: 1, kind: 'transfer', window_id: 'w_D_GS_1', to: 'GS-OREGON', attestation: { attestation_id: 'a_tr_04', grant_id: 'g_e51c0a3b', node_id: 'STARLINK-3005', op: 'transmit', output_bytes: 41210 } } })
  S.push({ t: 436, ev: () => ({ type: 'delivered', to: 'GS-OREGON', result: buildResult() }) })
  say(437, 'Delivered', 'Fire-perimeter assessment on the ground at T+436s, 284 s before deadline, $2.45 spent across three independent operators — all verifiable: receipts, grants, attestations.')
  S.push({ t: 480, ev: { type: 'window_close', window_id: 'w_D_GS_1' } })
  return S.sort((a, b) => a.t - b.t)
}

export function startMock() {
  const st = useStore.getState()
  st.setMode('mock')
  st.setScenario(scenario)
  st.reset()
  st.setHotspots(hotspots as Hotspot[])
  st.setConnected(true)
  const epoch = new Date(scenario.epoch_utc)
  const nodeIds = scenario.nodes.map((n) => n.node_id)
  const steps = script()
  let idx = 0
  let simT = 0
  let last = performance.now()
  let stopped = false
  let posAcc = 0

  const applyUpTo = (t: number) => {
    const s = useStore.getState()
    while (idx < steps.length && steps[idx].t <= t) {
      const ev = steps[idx].ev
      s.applyEvent({ ...(typeof ev === 'function' ? ev() : ev), sim_t: Math.floor(steps[idx].t) })
      idx++
    }
  }
  const startAt = Number(new URLSearchParams(location.search).get('t') ?? 0)
  if (startAt > 0) { simT = startAt; applyUpTo(startAt); st.setPositions(allPositions(nodeIds, epoch, simT)) }

  // ---- mock demos (same timeline, narrated as numbered steps)
  const DEMO_DEFS = [
    { id: 1, title: 'Impossible alone', subtitle: 'Two strangers, one deadline: conditional commitment, Stripe-paid grants, real inference on an InstaBox satellite', steps: [
      { t: 0, title: 'A mission arrives', detail: '3,812 real VIIRS fire detections over Papua; a perimeter is due in 12 minutes' },
      { t: 6, title: 'Impossible alone', detail: "SENTINEL-2A's own pass is after the deadline; raw relay does not fit the 40 s crosslink" },
      { t: 18, title: 'Two feasible plans, one choice', detail: 'Full-fidelity inference + relay $2.73 vs low-fidelity crop $0.84' },
      { t: 25, title: 'Conditional commitment', detail: 'Holds on every leg, then two MPP payments and two signed grants' },
      { t: 60, title: 'Real work on a stranger\'s machine', detail: 'PHISAT-2 verifies the grant offline and runs fire detection on the real scene' },
      { t: 125, title: 'Attestation', detail: 'Signed usage: 180 MB in, 41 KB out, 38 s compute, 28 Wh' },
    ] },
    { id: 2, title: 'Outage, refund, and a stranger', subtitle: 'The link dies after the work is done: result preserved, grant refunded, a new provider boots and gets paid', steps: [
      { t: 0, title: 'A mission arrives', detail: 'Same mission, same deadline' },
      { t: 25, title: 'Paid and running', detail: 'Two grants, two receipts' },
      { t: 76, title: 'Inference on PHISAT-2', detail: 'Grant verified offline; result committed on the satellite' },
      { t: 280, title: 'Ground-station outage after the work is done', detail: 'Result preserved, relay grant refunded by voucher' },
      { t: 290, title: 'No feasible path — and no invented answer', detail: 'The agent waits and watches the marketplace' },
      { t: 304, title: 'A stranger arrives', detail: 'Northstar Relay boots from a snapshot on InstaBox and publishes a signed manifest' },
      { t: 315, title: 'Zero-integration onboarding', detail: 'Manifest verified from its signature alone; quote, hold, pay, grant' },
      { t: 430, title: 'Metered downlink, settled on Stripe', detail: 'Bytes paid per 100 KB through an MPP session; delivered' },
    ] },
    { id: 3, title: 'Intent changes the deal, and a provider lies', subtitle: 'A cheaper mission picks the low-fidelity crop; reconciliation catches an over-reported attestation', steps: [
      { t: 0, title: 'A cheaper mission', detail: '"Rough extent, under $1.50" — intent, not a fixed rule, picks the plan' },
      { t: 20, title: 'Low-fidelity crop chosen', detail: '$0.84, 40 MB through the short crosslink, delivered T+306' },
      { t: 76, title: 'A provider over-reports', detail: 'Orbital Foundry attests 3× the compute it was granted' },
      { t: 125, title: 'Reconciliation catches it', detail: 'receipt ↔ grant ↔ attestation disagree; provider marked untrusted' },
      { t: 300, title: 'Delivered anyway', detail: 'The honest legs settle; the lying attestation is flagged' },
    ] },
  ]
  let demoId: number | null = null
  let demoStepIdx = 0
  const demoTick = () => {
    if (demoId == null) return
    const d = DEMO_DEFS.find((x) => x.id === demoId)!
    while (demoStepIdx < d.steps.length && d.steps[demoStepIdx].t <= simT) {
      const st = d.steps[demoStepIdx]
      useStore.getState().applyEvent({ type: 'demo_step', sim_t: Math.floor(simT), id: d.id, step: demoStepIdx + 1, total: d.steps.length, title: st.title, detail: st.detail })
      demoStepIdx++
    }
    if (useStore.getState().status === 'DELIVERED' && demoId != null) {
      const s = useStore.getState()
      s.applyEvent({ type: 'demo_done', sim_t: Math.floor(simT), id: demoId, status: 'DELIVERED', summary: { delivered_sim_t: s.result?.delivered_sim_t ?? Math.floor(simT), total_paid_usd: s.spentUsd, fidelity: demoId === 3 ? 'low' : 'full', reconcile_ok: demoId !== 3, reconcile_summary: demoId === 3 ? '3 grants, 2 fulfilled, 1 refunded, 2 violations' : '3 grants, 2 fulfilled, 1 refunded, 0 violations' } })
      demoId = null
    }
  }
  ;(window as any).__mockDemos = {
    list: () => DEMO_DEFS.map(({ id, title, subtitle, steps }) => ({ id, title, subtitle, steps: steps.map(({ title, detail }) => ({ title, detail })) })),
    start: (id: number) => {
      const d = DEMO_DEFS.find((x) => x.id === id) ?? DEMO_DEFS[0]
      ;(window as any).__mockClock.jump(0); useStore.setState({ paused: false })
      demoId = d.id; demoStepIdx = 0
      useStore.getState().applyEvent({ type: 'demo_started', sim_t: 0, id: d.id, title: d.title, subtitle: d.subtitle, total: d.steps.length })
      return { ok: true, id: d.id }
    },
    stop: () => { demoId = null; useStore.getState().setDemo({ running: false }); return { ok: true } },
    status: () => ({ running: demoId != null, step: demoStepIdx, total: demoId ? DEMO_DEFS.find((x) => x.id === demoId)!.steps.length : 0 }),
    stripe: () => {
      const s = useStore.getState(); const now = Math.floor(Date.now() / 1000)
      const payments = s.payments.filter((p) => !p.metered || p.settled).map((p, i) => ({ id: 'pi_3URv' + (p.receipt_ref || p.id).replace(/[^a-zA-Z0-9]/g, '').slice(2, 18).padEnd(16, 'x'), amount_cents: Math.max(1, Math.round(p.amount_usd * 100)), currency: 'usd', status: i === 0 && Date.now() - s.lastEventAt < 2500 ? 'processing' : 'succeeded', intent: (p.metered ? 'session' : 'charge') as 'session' | 'charge', created: now - Math.max(0, Math.floor((s.simT - p.sim_t) / Math.max(1, s.accel))), description: p.description ?? null, url: 'https://dashboard.stripe.com/test/payments' }))
      return { payments, account: 'acct_1URuY0GhDL5moMEd · sandbox', fetched_at: new Date().toISOString() }
    },
    instabox: () => {
      const s = useStore.getState(); const n = s.nodes
      const box = (name: string, node: string, role: string, url: string, on: boolean, extra: any = {}) => ({ name, state: 'Running', template: 'agent-browser', node_id: node, operator_id: name, role, public_url: url, operator: on ? { online: true, sim_t: Math.floor(s.simT), grants: n[node]?.grants ?? { active: 0, fulfilled: 0, revoked: 0 }, rail: 'stripe', ...extra } : null })
      return { boxes: [
        box('orbital-foundry', 'PHISAT-2', 'compute', 'https://7001-agqu6w7vgunkts2l5yop63jie4.instabox.tech', true, { power_wh: Math.round(n['PHISAT-2']?.power_pct ?? 100) }),
        box('lumen-relay', 'EDRS-C', 'relay', 'https://7002-agqu6xts2sw3yul4iq7yfow2wq.instabox.tech', true, { capacity: { mb: 500 } }),
        box('northstar-relay', 'STARLINK-3005', 'relay', 'https://7003-agqu6xuufihmjk27jkjrx2n4ia.instabox.tech', !!n['STARLINK-3005']?.online, { capacity: { mb: 200 } }),
      ], fetched_at: new Date().toISOString() }
    },
  }

  const loop = () => {
    if (stopped) return
    const s = useStore.getState()
    const now = performance.now()
    const dt = Math.min(0.5, (now - last) / 1000)
    last = now
    if (!s.paused) {
      simT += dt * s.accel
      applyUpTo(simT)
      demoTick()
      posAcc += dt
      if (posAcc > 0.25) {
        posAcc = 0
        s.setPositions(allPositions(nodeIds, epoch, simT))
      }
      s.applyEvent({ type: 'tick', sim_t: Math.floor(simT) })
      // loop the story after a while
      if (simT > 560 && demoId == null) { simT = 0; idx = 0; s.reset() }
    }
  }
  const timer = setInterval(loop, 50)

  // mock clock control hooks (+ a direct emitter used by the screenshot harness)
  ;(window as any).__mockEmit = (ev: SimEvent) => useStore.getState().applyEvent({ ...ev, sim_t: Math.floor(simT) })
  ;(window as any).__mockClock = {
    pause: () => useStore.setState({ paused: true }),
    resume: () => useStore.setState({ paused: false }),
    setAccel: (a: number) => useStore.setState({ accel: a }),
    jump: (t: number) => { simT = t; idx = steps.findIndex((x) => x.t > t); if (idx < 0) idx = steps.length; useStore.getState().reset(); for (let i = 0; i < idx; i++) { const ev = steps[i].ev; useStore.getState().applyEvent({ ...(typeof ev === 'function' ? ev() : ev), sim_t: steps[i].t }) } },
    disrupt: (type: string, body: any) => {
      // only a couple of disruptions are meaningful in mock: kill/restore link
      const s = useStore.getState()
      if (type === 'kill_link' && body.window_id) s.applyEvent({ type: 'link_killed', sim_t: Math.floor(simT), window_id: body.window_id, reason: body.label ?? 'judge' })
      if (type === 'launch_provider' && body.node_id) s.applyEvent({ type: 'provider_online', sim_t: Math.floor(simT), node_id: body.node_id, operator_name: 'Northstar Relay', late: true, base_url: 'https://7003-agqu6xuufihmjk27jkjrx2n4ia.instabox.tech' })
      if (type === 'competing_reserve' && body.node_id) s.applyEvent({ type: 'capacity', sim_t: Math.floor(simT), node_id: body.node_id, capacity_pct: 40, price_usd: 3.4, label: 'competing mission took 60% capacity' })
      if (type === 'revoke' && body.node_id) s.applyEvent({ type: 'grant_revoked', sim_t: Math.floor(simT), node_id: body.node_id, operator_id: body.node_id, reason: 'operator revoked unfulfilled capacity' })
    },
  }
  return () => { stopped = true; clearInterval(timer) }
}
