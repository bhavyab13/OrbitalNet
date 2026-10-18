import { create } from 'zustand'
import type {
  AuditItem, ContactWindow, Hotspot, MissionResult, MissionStatus, NarrationItem, NodeLive,
  Payment, Plan, Scenario, SimEvent, Transfer, WindowStatus,
} from './types'

let seq = 0
const uid = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`

export interface State {
  mode: 'live' | 'mock'
  connected: boolean
  scenario: Scenario | null
  simT: number
  accel: number
  paused: boolean
  status: MissionStatus
  missionId?: string
  spentUsd: number
  refundedUsd: number
  plans: Plan[]
  chosenPlanId?: string
  currentLegIndex?: number
  windows: Record<string, ContactWindow>
  nodes: Record<string, NodeLive>
  transfers: Record<string, Transfer>
  payments: Payment[]
  audit: AuditItem[]
  narration: NarrationItem[]
  currentAct?: string
  result?: MissionResult
  resultOpen: boolean
  storyMode: boolean
  hotspots: Hotspot[]
  committedNode?: string
  focusLink?: [string, string]
  lastEventAt: number

  setScenario: (s: Scenario) => void
  setMode: (m: 'live' | 'mock') => void
  setConnected: (c: boolean) => void
  setHotspots: (h: Hotspot[]) => void
  setPositions: (p: Record<string, { pos: { lat: number; lon: number; alt_km: number }; trail?: [number, number, number][]; trailT?: number[] }>) => void
  applyEvent: (e: SimEvent) => void
  applyState: (s: any) => void
  setResultOpen: (o: boolean) => void
  setStoryMode: (o: boolean) => void
  reset: () => void
}

function windowStatus(w: ContactWindow, simT: number, killed: boolean): WindowStatus {
  if (killed) return 'killed'
  if (simT < w.start) return 'future'
  if (simT > w.end) return 'closed'
  return 'open'
}

const baseNodes = (s: Scenario): Record<string, NodeLive> => {
  const out: Record<string, NodeLive> = {}
  for (const n of s.nodes) {
    out[n.node_id] = {
      online: !n.joins_late,
      grants: { active: 0, fulfilled: 0, revoked: 0 },
      capacity_pct: 100,
      power_pct: 100,
      price_usd: n.capability?.price_base_usd ?? n.capability?.price_min_usd ?? undefined,
    }
  }
  return out
}

export const useStore = create<State>((set, get) => ({
  mode: 'live',
  connected: false,
  scenario: null,
  simT: 0,
  accel: 4,
  paused: false,
  status: 'IDLE',
  spentUsd: 0,
  refundedUsd: 0,
  plans: [],
  windows: {},
  nodes: {},
  transfers: {},
  payments: [],
  audit: [],
  narration: [],
  resultOpen: false,
  storyMode: false,
  hotspots: [],
  lastEventAt: 0,

  setScenario: (s) => {
    const windows: Record<string, ContactWindow> = {}
    for (const w of s.windows) windows[w.window_id] = { ...w, status: 'future', used_mb: 0, capacity_mb: ((w.end - w.start) * w.bandwidth_mbps) / 8 }
    set({ scenario: s, windows, nodes: baseNodes(s), accel: s.sim?.accel ?? 4 })
  },
  setMode: (mode) => set({ mode }),
  setConnected: (connected) => set({ connected }),
  setHotspots: (hotspots) => set({ hotspots }),
  setPositions: (p) => {
    const nodes = { ...get().nodes }
    for (const [id, v] of Object.entries(p)) {
      nodes[id] = { ...(nodes[id] ?? { online: true, grants: { active: 0, fulfilled: 0, revoked: 0 } }), pos: v.pos, trail: v.trail ?? nodes[id]?.trail, trailT: v.trailT ?? nodes[id]?.trailT }
    }
    set({ nodes })
  },
  setResultOpen: (resultOpen) => set({ resultOpen }),
  setStoryMode: (storyMode) => set({ storyMode }),
  reset: () => {
    const s = get().scenario
    if (!s) return
    get().setScenario(s)
    set({ simT: 0, status: 'IDLE', spentUsd: 0, refundedUsd: 0, plans: [], chosenPlanId: undefined, currentLegIndex: undefined, transfers: {}, payments: [], audit: [], narration: [], currentAct: undefined, result: undefined, resultOpen: false, committedNode: undefined, focusLink: undefined })
  },

  applyState: (st) => {
    // Full state snapshot from GET /state — tolerant merge
    const patch: Partial<State> = {}
    if (typeof st.sim_t === 'number') patch.simT = st.sim_t
    if (typeof st.real_accel === 'number') patch.accel = st.real_accel
    if (typeof st.accel === 'number') patch.accel = st.accel
    if (typeof st.paused === 'boolean') patch.paused = st.paused
    const windows = { ...get().windows }
    if (Array.isArray(st.windows)) {
      for (const w of st.windows) {
        const prev = windows[w.window_id] ?? { used_mb: 0 }
        windows[w.window_id] = { ...prev, ...w, status: w.status ?? prev.status }
      }
      patch.windows = windows
    }
    const nodes = { ...get().nodes }
    if (Array.isArray(st.nodes)) {
      for (const n of st.nodes) {
        const prev = nodes[n.node_id] ?? { online: true, grants: { active: 0, fulfilled: 0, revoked: 0 } }
        nodes[n.node_id] = {
          ...prev,
          online: n.online ?? prev.online,
          pos: typeof n.lat === 'number' ? { lat: n.lat, lon: n.lon, alt_km: n.alt_km ?? 500 } : prev.pos,
        }
      }
      patch.nodes = nodes
    }
    if (st.missions && typeof st.missions === 'object') {
      const m = Object.values<any>(st.missions)[0]
      if (m?.status) patch.status = m.status
      if (m?.mission_id) patch.missionId = m.mission_id
    }
    set(patch)
  },

  applyEvent: (e) => {
    const s = get()
    const simT = typeof e.sim_t === 'number' ? e.sim_t : s.simT
    const patch: Partial<State> = { simT, lastEventAt: Date.now() }
    const push = <T,>(arr: T[], item: T, max = 200) => [item, ...arr].slice(0, max)
    const audit = (kind: AuditItem['kind'], text: string, severity: AuditItem['severity'], detail?: string) =>
      (patch.audit = push(patch.audit ?? s.audit, { id: uid(), sim_t: simT, kind, text, severity, detail }))

    switch (e.type) {
      case 'tick': {
        if (typeof e.accel === 'number') patch.accel = e.accel
        if (typeof e.paused === 'boolean') patch.paused = e.paused
        // refresh window statuses by time
        const windows = { ...s.windows }
        for (const id of Object.keys(windows)) {
          const w = windows[id]
          if (w.status === 'killed') continue
          const st = windowStatus(w, simT, false)
          if (st !== w.status) windows[id] = { ...w, status: st }
        }
        patch.windows = windows
        break
      }
      case 'clock': {
        if (typeof e.accel === 'number') patch.accel = e.accel
        if (typeof e.paused === 'boolean') patch.paused = e.paused
        break
      }
      case 'window_open': {
        const w = s.windows[e.window_id]
        if (w) patch.windows = { ...s.windows, [e.window_id]: { ...w, status: 'open' } }
        break
      }
      case 'window_close': {
        const w = s.windows[e.window_id]
        if (w && w.status !== 'killed') patch.windows = { ...s.windows, [e.window_id]: { ...w, status: 'closed' } }
        break
      }
      case 'link_killed': {
        const w = s.windows[e.window_id]
        if (w) patch.windows = { ...s.windows, [e.window_id]: { ...w, status: 'killed' } }
        audit('info', `Link ${e.window_id} lost${e.reason ? ` — ${e.reason}` : ''}`, 'bad', e.label)
        break
      }
      case 'link_restored': {
        const w = s.windows[e.window_id]
        if (w) patch.windows = { ...s.windows, [e.window_id]: { ...w, status: windowStatus(w, simT, false) } }
        audit('info', `Link ${e.window_id} restored`, 'ok')
        break
      }
      case 'transfer_progress': {
        const t: Transfer = {
          window_id: e.window_id, from: e.from, to: e.to,
          bytes_moved_mb: e.bytes_moved_mb ?? 0, bytes_total_mb: e.bytes_total_mb ?? 0,
          pct: e.pct ?? (e.bytes_total_mb ? (100 * e.bytes_moved_mb) / e.bytes_total_mb : 0),
          done: (e.pct ?? 0) >= 100,
        }
        patch.transfers = { ...s.transfers, [e.window_id]: t }
        const w = s.windows[e.window_id]
        if (w) patch.windows = { ...(patch.windows ?? s.windows), [e.window_id]: { ...w, used_mb: t.bytes_moved_mb, status: w.status === 'killed' ? 'killed' : 'open' } }
        patch.focusLink = [e.from, e.to]
        break
      }
      case 'leg_start': {
        patch.currentLegIndex = e.leg_index
        if (e.from && e.to) patch.focusLink = [e.from, e.to]
        else if (e.node) patch.focusLink = [e.node, e.node]
        patch.status = 'RUNNING'
        if (e.kind === 'compute') audit('info', `Compute started on ${e.node} (${e.op ?? 'image-inference'})`, 'info')
        break
      }
      case 'leg_done': {
        const a = e.attestation
        if (a) {
          audit('attestation', `Attestation ${String(a.attestation_id ?? '').slice(0, 10)} · ${a.node_id} · ${a.op ?? (e.kind ?? 'transfer')}`, 'ok',
            [a.input_bytes != null ? `in ${(a.input_bytes / 1e6).toFixed(1)} MB` : null,
             a.output_bytes != null ? `out ${(a.output_bytes / 1e3).toFixed(0)} KB` : null,
             a.compute_s != null ? `${a.compute_s}s compute` : null,
             a.power_wh != null ? `${a.power_wh} Wh` : null].filter(Boolean).join(' · '))
          const nid = a.node_id ?? e.node
          if (nid && s.nodes[nid]) {
            const n = s.nodes[nid]
            patch.nodes = { ...(patch.nodes ?? s.nodes), [nid]: { ...n, grants: { ...n.grants, active: Math.max(0, n.grants.active - 1), fulfilled: n.grants.fulfilled + 1 }, power_pct: a.power_wh != null && e.power_budget_wh ? Math.max(0, (n.power_pct ?? 100) - (100 * a.power_wh) / e.power_budget_wh) : n.power_pct } }
          }
        }
        if (e.kind === 'compute' && e.node) patch.committedNode = e.node
        if (e.window_id && s.transfers[e.window_id]) patch.transfers = { ...s.transfers, [e.window_id]: { ...s.transfers[e.window_id], pct: 100, done: true } }
        break
      }
      case 'mission_status': {
        if (e.status) patch.status = e.status
        if (e.mission_id) patch.missionId = e.mission_id
        if (typeof e.current_leg === 'number') patch.currentLegIndex = e.current_leg
        if (e.committed?.node_id) patch.committedNode = e.committed.node_id
        break
      }
      case 'mission_submitted':
      case 'mission_created': {
        patch.status = 'PLANNED'
        if (e.mission_id) patch.missionId = e.mission_id
        break
      }
      case 'plans':
      case 'plan_candidates': {
        if (Array.isArray(e.plans)) patch.plans = e.plans
        break
      }
      case 'plan_chosen': {
        const plans: Plan[] = Array.isArray(e.plans) ? e.plans : s.plans
        const chosen = e.plan_id ?? e.plan?.plan_id
        patch.plans = plans.map((p) => ({ ...p, chosen: p.plan_id === chosen }))
        if (e.plan && !plans.find((p) => p.plan_id === e.plan.plan_id)) patch.plans = [...patch.plans, { ...e.plan, chosen: true }]
        patch.chosenPlanId = chosen
        patch.status = s.status === 'IDLE' ? 'PLANNED' : s.status
        break
      }
      case 'payment': {
        const p: Payment = { id: uid(), sim_t: simT, operator_id: e.operator_id, node_id: e.node_id, amount_usd: Number(e.amount_usd ?? 0), method: e.method ?? 'mpp', receipt_ref: e.receipt_ref ?? '', description: e.description }
        patch.payments = push(s.payments, p)
        patch.spentUsd = s.spentUsd + p.amount_usd
        break
      }
      case 'refund': {
        const amt = Number(e.amount_usd ?? 0)
        patch.refundedUsd = s.refundedUsd + amt
        patch.spentUsd = Math.max(0, s.spentUsd - amt)
        audit('refund', `Refund voucher from ${e.operator_id ?? e.node_id} · $${amt.toFixed(2)}`, 'warn', e.reason)
        break
      }
      case 'grant_issued': {
        const g = e.grant ?? e
        audit('grant_issued', `Grant ${String(g.grant_id ?? '').slice(0, 10)} · ${g.node_id ?? e.node_id} · ${g.capability ?? ''} ${g.window_id ? `@ ${g.window_id}` : ''}`, 'ok',
          g.price_usd != null ? `$${Number(g.price_usd).toFixed(2)} · valid until T+${g.valid_sim_t?.not_after ?? '?'}s · receipt ${String(g.payment?.receipt_ref ?? '').slice(0, 12)}` : undefined)
        const nid = g.node_id ?? e.node_id
        if (nid && s.nodes[nid]) {
          const n = s.nodes[nid]
          patch.nodes = { ...(patch.nodes ?? s.nodes), [nid]: { ...n, grants: { ...n.grants, active: n.grants.active + 1 } } }
        }
        break
      }
      case 'grant_rejected': {
        audit('grant_rejected', `Grant rejected by ${e.node_id ?? e.operator_id}: ${e.reason ?? 'unknown'}`, 'bad', e.detail)
        break
      }
      case 'grant_revoked': {
        audit('revoked', `Grant ${String(e.grant_id ?? '').slice(0, 10)} revoked by ${e.operator_id ?? e.node_id}`, 'warn', e.reason)
        const nid = e.node_id
        if (nid && s.nodes[nid]) {
          const n = s.nodes[nid]
          patch.nodes = { ...(patch.nodes ?? s.nodes), [nid]: { ...n, grants: { ...n.grants, active: Math.max(0, n.grants.active - 1), revoked: n.grants.revoked + 1 } } }
        }
        break
      }
      case 'hold': {
        audit('hold', `Hold placed on ${e.node_id} ${e.window_id ? `@ ${e.window_id}` : ''}`, 'info')
        break
      }
      case 'quote': {
        const nid = e.node_id
        if (nid && s.nodes[nid]) patch.nodes = { ...(patch.nodes ?? s.nodes), [nid]: { ...s.nodes[nid], price_usd: Number(e.price_usd) } }
        break
      }
      case 'capacity': {
        const nid = e.node_id
        if (nid && s.nodes[nid]) patch.nodes = { ...(patch.nodes ?? s.nodes), [nid]: { ...s.nodes[nid], capacity_pct: e.capacity_pct ?? s.nodes[nid].capacity_pct, power_pct: e.power_pct ?? s.nodes[nid].power_pct, price_usd: e.price_usd ?? s.nodes[nid].price_usd, capacity_label: e.label } }
        if (e.label) audit('info', `${nid}: ${e.label}`, 'warn')
        break
      }
      case 'provider_online': {
        const nid = e.node_id
        if (nid) {
          const n = s.nodes[nid] ?? { grants: { active: 0, fulfilled: 0, revoked: 0 } }
          patch.nodes = { ...(patch.nodes ?? s.nodes), [nid]: { ...n, online: true } }
        }
        audit('info', `Provider online: ${e.operator_name ?? e.operator_id ?? nid} (${nid}) — manifest verified`, 'ok', e.manifest_url)
        break
      }
      case 'provider_offline': {
        const nid = e.node_id
        if (nid && s.nodes[nid]) patch.nodes = { ...(patch.nodes ?? s.nodes), [nid]: { ...s.nodes[nid], online: false } }
        break
      }
      case 'replan_required': {
        patch.status = 'REPLAN_REQUIRED'
        audit('info', `Replan required: ${e.reason ?? 'disruption'}`, 'warn')
        break
      }
      case 'delivered': {
        patch.status = 'DELIVERED'
        patch.result = { ...(s.result ?? {}), ...(e.result ?? {}), delivered_sim_t: simT, delivered_to: e.to ?? e.ground_station }
        patch.resultOpen = true
        audit('info', `Delivered to ${e.to ?? e.ground_station ?? 'ground'} at T+${simT}s`, 'ok')
        break
      }
      case 'infeasible': {
        patch.status = 'INFEASIBLE'
        audit('info', `Mission infeasible: ${e.reason ?? ''}`, 'bad')
        break
      }
      case 'narration': {
        patch.narration = push(s.narration, { id: uid(), sim_t: simT, act: e.act, text: e.text }, 60)
        if (e.act) patch.currentAct = e.act
        break
      }
      case 'result': {
        patch.result = { ...(s.result ?? {}), ...(e.result ?? e) }
        break
      }
      default:
        break
    }
    set(patch)
  },
}))
