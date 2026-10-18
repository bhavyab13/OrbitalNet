/**
 * Protocol-object effects: grants as rings, money as particles, late-provider burst, result on the globe,
 * camera cues, sponsor stamps and sound cues. Driven from the same event stream as the main store
 * (store.applyEvent calls fxOnEvent) but kept in its own store so the globe can animate at 60 fps.
 */
import { create } from 'zustand'
import type { SimEvent } from './types'
import type { State } from './store'

export type RingState = 'issued' | 'fulfilled' | 'revoked'
export interface GrantRing { grant_id: string; node_id: string; state: RingState; at: number; stateAt: number }
export interface MoneyParticle { id: string; from: string; to: string; amount: number; at: number; dur: number; kind: 'pay' | 'refund' | 'spark' }
export interface ProviderBurst { node_id: string; at: number; label: string }
export type Sponsor = 'Stripe' | 'InstaBox' | 'Manufact'
export interface SponsorPing { id: string; sponsor: Sponsor; text: string; at: number }
export interface CameraCue { kind: 'papua' | 'link' | 'pullout' | 'node' | 'result' | 'idle'; nodes?: string[]; at: number }

export const BUYER_ID = 'BUYER-OPS'
/** Emergency operations centre (Darwin, AU) — the buyer's ground presence. */
export const BUYER_POS = { lat: -12.46, lon: 130.84, alt_km: 0 }
export const GOLD = '#ffd166'
/** Effect clock: real time, or a frozen value set by the screenshot harness (window.__fxNow). */
export const fxNow = () => (typeof window !== 'undefined' && (window as any).__fxNow) || Date.now()

export interface FxState {
  rings: Record<string, GrantRing>
  particles: MoneyParticle[]
  bursts: Record<string, ProviderBurst>
  pings: SponsorPing[]
  counts: Record<Sponsor, number>
  cue?: CameraCue
  resultGeo?: { features: any[]; fidelity: 'full' | 'low'; bbox?: number[]; at: number }
  activeMetered?: { from: string; to: string }
  soundOn: boolean
  setSoundOn: (b: boolean) => void
  clear: () => void
}

let seq = 0
const uid = () => `fx${Date.now().toString(36)}${(seq++).toString(36)}`

export const useFx = create<FxState>((set) => ({
  rings: {},
  particles: [],
  bursts: {},
  pings: [],
  counts: { Stripe: 0, InstaBox: 0, Manufact: 0 },
  soundOn: false,
  setSoundOn: (soundOn) => set({ soundOn }),
  clear: () => set({ rings: {}, particles: [], bursts: {}, pings: [], counts: { Stripe: 0, InstaBox: 0, Manufact: 0 }, cue: undefined, resultGeo: undefined, activeMetered: undefined }),
}))

// ---------- sound (WebAudio, synthesized, muted by default) ----------
let ctx: AudioContext | null = null
function blip(freq: number, dur = 0.12, type: OscillatorType = 'sine', gain = 0.05, slide = 0) {
  try {
    if (!useFx.getState().soundOn) return
    ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)()
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, ctx.currentTime)
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), ctx.currentTime + dur)
    g.gain.setValueAtTime(gain, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur)
    o.connect(g).connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + dur + 0.02)
  } catch { /* no audio */ }
}
export const sound = {
  grant: () => { blip(880, 0.09, 'triangle', 0.04); setTimeout(() => blip(1320, 0.12, 'triangle', 0.035), 70) },
  payment: () => blip(1760, 0.16, 'sine', 0.045, -600),
  refund: () => { blip(660, 0.14, 'sine', 0.04, -220); setTimeout(() => blip(440, 0.18, 'sine', 0.035, -120), 110) },
}

const shortRef = (r?: string) => (r ? (r.length > 14 ? `${r.slice(0, 8)}…${r.slice(-4)}` : r) : '')

export function fxOnEvent(e: SimEvent, _s: State) {
  const fx = useFx.getState()
  const now = fxNow()
  const patch: Partial<FxState> = {}
  const ping = (sponsor: Sponsor, text: string) => {
    patch.pings = [{ id: uid(), sponsor, text, at: now }, ...(patch.pings ?? fx.pings)].slice(0, 12)
    patch.counts = { ...(patch.counts ?? fx.counts), [sponsor]: (patch.counts ?? fx.counts)[sponsor] + 1 }
  }
  const rings = () => (patch.rings ??= { ...fx.rings })
  const setRingByNode = (node_id: string | undefined, state: RingState, grant_id?: string) => {
    const r = rings()
    if (grant_id && r[grant_id]) { r[grant_id] = { ...r[grant_id], state, stateAt: now }; return }
    // fall back: the newest non-terminal ring on that node
    const cand = Object.values(r).filter((x) => x.node_id === node_id && x.state === 'issued').sort((a, b) => b.at - a.at)[0]
    if (cand) r[cand.grant_id] = { ...cand, state, stateAt: now }
  }

  switch (e.type) {
    case 'grant_issued': {
      const g = e.grant ?? e
      const grant_id = String(g.grant_id ?? e.grant_id ?? uid())
      const node_id = String(g.node_id ?? e.node_id ?? '')
      if (node_id) {
        const r = rings()
        // keep at most 2 rings per node: drop the oldest terminal one
        const mine = Object.values(r).filter((x) => x.node_id === node_id).sort((a, b) => a.at - b.at)
        if (mine.length >= 2) delete r[mine[0].grant_id]
        r[grant_id] = { grant_id, node_id, state: 'issued', at: now, stateAt: now }
        sound.grant()
      }
      break
    }
    case 'grant_fulfilled': {
      setRingByNode(e.node_id, 'fulfilled', e.grant_id)
      break
    }
    case 'leg_done': {
      const a = e.attestation
      if (a && (e.kind === 'compute' || a.op === 'image-inference' || a.op === 'transmit' || e.kind === 'transfer')) {
        const nid = a.node_id ?? e.node
        // only a provider's own leg fulfils its grant: compute on the node, or the final transmit by a relay
        if (nid && (e.kind === 'compute' || a.op === 'transmit' || a.op === 'relay' || (e.to && String(e.to).startsWith('GS-')))) setRingByNode(nid, 'fulfilled', a.grant_id)
      }
      break
    }
    case 'refund': {
      setRingByNode(e.node_id, 'revoked', e.grant_id)
      const to = e.node_id ?? e.operator_id
      if (to) patch.particles = [...fx.particles, { id: uid(), from: String(to), to: BUYER_ID, amount: Number(e.amount_usd ?? 0), at: now, dur: 2200, kind: 'refund' }]
      sound.refund()
      break
    }
    case 'grant_revoked':
    case 'capacity_revoked': {
      const ids: string[] = Array.isArray(e.grant_ids) ? e.grant_ids : e.grant_id ? [e.grant_id] : []
      if (ids.length) { const r = rings(); for (const id of ids) if (r[id]) r[id] = { ...r[id], state: 'revoked', stateAt: now } }
      else setRingByNode(e.node_id, 'revoked')
      break
    }
    case 'payment': {
      if (e.method === 'mpp-session' || e.metered) {
        ping('Stripe', `MPP session settled · $${Number(e.amount_usd ?? 0).toFixed(4)} · ${shortRef(e.receipt_ref ?? e.settlement_refs?.[0])}`)
        break
      }
      const to = e.node_id ?? e.operator_id
      if (to) {
        patch.particles = [...fx.particles, { id: uid(), from: BUYER_ID, to: String(to), amount: Number(e.amount_usd ?? 0), at: now, dur: 1400, kind: 'pay' }]
        patch.cue = { kind: 'link', nodes: [BUYER_ID, String(to)], at: now }
      }
      const m = String(e.method ?? 'mpp')
      if (['tempo', 'spt', 'stripe', 'mpp'].includes(m)) ping('Stripe', `MPP · 402 paid (${m}) · $${Number(e.amount_usd ?? 0).toFixed(2)} · ${shortRef(e.receipt_ref)}`)
      sound.payment()
      break
    }
    case 'metered_start':
    case 'metered_usage': {
      if (e.from && e.to) patch.activeMetered = { from: e.from, to: e.to }
      else if (e.node_id) patch.activeMetered = { from: e.node_id, to: e.to ?? '' }
      // sparks every few units
      if (((e.units ?? 0) % 3) === 0 && e.node_id) patch.particles = [...fx.particles.slice(-24), { id: uid(), from: e.node_id, to: e.to ?? BUYER_ID, amount: 0, at: now, dur: 700, kind: 'spark' }]
      break
    }
    case 'metered_settled': {
      patch.activeMetered = undefined
      ping('Stripe', `MPP session settled · $${Number(e.total_usd ?? 0).toFixed(4)} · ${e.settlement_refs?.length ?? 0} on-chain settlement${(e.settlement_refs?.length ?? 0) === 1 ? '' : 's'}`)
      break
    }
    case 'provider_online': {
      const nid = e.node_id
      const wasOffline = nid && _s.nodes[nid] && _s.nodes[nid].online === false
      if (nid && (wasOffline || e.late)) {
        patch.bursts = { ...fx.bursts, [nid]: { node_id: nid, at: now, label: 'manifest verified · sig ok' } }
        patch.cue = { kind: 'node', nodes: [nid], at: now }
      }
      const url = String(e.base_url ?? e.manifest_url ?? '')
      if (url.includes('instabox.tech') || nid === 'STARLINK-3005') {
        let host = ''
        try { host = new URL(url).host } catch { host = url }
        ping('InstaBox', `${nid} booted on ${host || 'an InstaBox'}`)
      }
      break
    }
    case 'mcp_client_call': {
      ping('Manufact', `MCP tool ${e.tool ?? 'call'} from ${e.client ?? 'agent'}`)
      break
    }
    case 'narration': {
      const txt = String(e.text ?? '')
      if ((e.source === 'broker' || /^Broker:/.test(txt)) && /client=|Claude Desktop|ChatGPT|Cursor|Claude Code/i.test(txt)) {
        const m = txt.match(/client=([\w./-]+)/)
        ping('Manufact', `MCP call from ${m?.[1] ?? 'an external agent'}`)
      }
      if (e.act === 'arrival' || /^Act 1/.test(String(e.act ?? ''))) patch.cue = { kind: 'papua', at: now }
      break
    }
    case 'mission_created':
    case 'mission_submitted': {
      patch.cue = { kind: 'papua', at: now }
      break
    }
    case 'window_open': {
      // frame the link only if it belongs to the chosen plan (active leg)
      const chosen = _s.plans.find((p) => p.chosen)
      const leg = chosen?.legs.find((l) => l.window_id === e.window_id)
      if (leg && leg.from && leg.to) patch.cue = { kind: 'link', nodes: [leg.from, leg.to], at: now }
      break
    }
    case 'leg_start': {
      if (e.from && e.to) patch.cue = { kind: 'link', nodes: [e.from, e.to], at: now }
      else if (e.node) patch.cue = { kind: 'node', nodes: [e.node], at: now }
      break
    }
    case 'link_killed': {
      patch.cue = { kind: 'pullout', at: now }
      break
    }
    case 'result': {
      const r = e.result ?? e
      if (r?.geojson || r?.fidelity) patch.resultGeo = { features: r.geojson?.features ?? [], fidelity: r.fidelity === 'low' ? 'low' : 'full', bbox: r.summary?.bbox ?? r.bbox, at: now }
      break
    }
    case 'delivered': {
      const r = e.result
      if (r) patch.resultGeo = { features: r.geojson?.features ?? [], fidelity: (r.fidelity ?? e.fidelity) === 'low' ? 'low' : 'full', bbox: r.summary?.bbox ?? r.bbox, at: now }
      patch.cue = { kind: 'result', at: now }
      break
    }
    case 'reset': {
      fx.clear()
      return
    }
    default:
      break
  }
  if (Object.keys(patch).length) useFx.setState(patch)
}

if (typeof window !== 'undefined') (window as any).__fx = useFx
