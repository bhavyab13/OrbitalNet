import { useStore } from '../store'
import type { Hotspot, Scenario, SimEvent } from '../types'

export const SIM_URL: string = (import.meta.env.VITE_SIM_URL as string) || 'http://localhost:8000'
export const MOCK: boolean = String(import.meta.env.VITE_MOCK ?? '') === '1'
export const EXPLORER_TX_URL: string = (import.meta.env.VITE_EXPLORER_TX_URL as string) || 'https://explore.tempo.xyz/tx/'

const wsUrl = () => SIM_URL.replace(/^http/, 'ws') + '/ws'

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(SIM_URL + path)
  if (!r.ok) throw new Error(`${path} ${r.status}`)
  return r.json()
}

export async function postJson<T = any>(path: string, body: any): Promise<T> {
  const r = await fetch(SIM_URL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  if (!r.ok) throw new Error(`${path} ${r.status}`)
  return r.json().catch(() => ({}))
}

export const api = {
  disrupt: (body: any) => postJson('/disrupt', body),
  clock: (body: any) => postJson('/clock', body),
  reset: () => postJson('/reset', {}),
  sceneImage: () => `${SIM_URL}/scene/image`,
  sceneTruecolor: () => `${SIM_URL}/scene/truecolor`,
}

let socket: WebSocket | null = null
let stopped = false
let posTimer: any = null

/** Connect to the live sim: scenario, state snapshot, positions, hotspots, WS events. */
export function connectLive() {
  const st = useStore.getState()
  st.setMode('live')
  stopped = false

  const loadScenario = async () => {
    try {
      const s = await getJson<any>('/scenario')
      st.setScenario(s as Scenario)
    } catch {
      // fallback: bundled copy
      const s = (await import('../mock/scenario.json')).default as unknown as Scenario
      st.setScenario(s)
    }
  }
  const loadState = async () => {
    try { useStore.getState().applyState(await getJson('/state')) } catch { /* sim down */ }
  }
  const loadHotspots = async () => {
    try {
      const h = await getJson<any>('/scene/hotspots')
      const arr: Hotspot[] = Array.isArray(h) ? h : (h.hotspots ?? h.features?.map((f: any) => ({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], frp: f.properties?.frp ?? 1 })) ?? [])
      useStore.getState().setHotspots(arr)
    } catch {
      const h = (await import('../mock/hotspots.json')).default as Hotspot[]
      useStore.getState().setHotspots(h)
    }
  }
  const loadPositions = async () => {
    try {
      const s = useStore.getState()
      const from = Math.max(0, s.simT - 1200), to = s.simT + 2400
      const p = await getJson<any>(`/positions?from=${from}&to=${to}&step=20`)
      const map: Record<string, any> = {}
      const data = p.positions ?? p
      for (const [id, rows] of Object.entries<any>(data)) {
        if (!Array.isArray(rows) || !rows.length) continue
        // pick the row closest to current simT
        let best = rows[0]
        for (const r of rows) if (Math.abs(r[0] - s.simT) < Math.abs(best[0] - s.simT)) best = r
        map[id] = { pos: { lat: best[1], lon: best[2], alt_km: best[3] }, trail: rows.map((r: any) => [r[1], r[2], r[3]]), trailT: rows.map((r: any) => r[0]) }
      }
      useStore.getState().setPositions(map)
    } catch { /* ignore */ }
  }

  const open = () => {
    if (stopped) return
    try {
      socket = new WebSocket(wsUrl())
    } catch { setTimeout(open, 2000); return }
    socket.onopen = () => { useStore.getState().setConnected(true); loadState(); loadPositions() }
    socket.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as SimEvent
        if (e.type === 'state') useStore.getState().applyState(e)
        else useStore.getState().applyEvent(e)
      } catch { /* ignore */ }
    }
    socket.onclose = () => { useStore.getState().setConnected(false); if (!stopped) setTimeout(open, 1500) }
    socket.onerror = () => { socket?.close() }
  }

  loadScenario().then(() => { loadState(); loadHotspots(); loadPositions(); open() })
  posTimer = setInterval(loadPositions, 5000)
  return () => { stopped = true; socket?.close(); clearInterval(posTimer) }
}
