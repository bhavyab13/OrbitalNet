import * as sat from 'satellite.js'
import { TLES } from './tles'

const recs: Record<string, sat.SatRec> = {}
for (const [id, [l1, l2]] of Object.entries(TLES)) recs[id] = sat.twoline2satrec(l1, l2)

export function positionAt(nodeId: string, epoch: Date, simT: number): { lat: number; lon: number; alt_km: number } | null {
  const rec = recs[nodeId]
  if (!rec) return null
  const t = new Date(epoch.getTime() + simT * 1000)
  const pv = sat.propagate(rec, t)
  const pos = pv?.position
  if (!pos || typeof pos === 'boolean') return null
  const gmst = sat.gstime(t)
  const geo = sat.eciToGeodetic(pos as sat.EciVec3<number>, gmst)
  return { lat: sat.degreesLat(geo.latitude), lon: sat.degreesLong(geo.longitude), alt_km: geo.height }
}

export function trail(nodeId: string, epoch: Date, fromT: number, toT: number, step = 20): [number, number, number][] {
  const out: [number, number, number][] = []
  for (let t = fromT; t <= toT; t += step) {
    const p = positionAt(nodeId, epoch, t)
    if (p) out.push([p.lat, p.lon, p.alt_km])
  }
  return out
}

export function allPositions(nodeIds: string[], epoch: Date, simT: number) {
  const map: Record<string, { pos: { lat: number; lon: number; alt_km: number }; trail: [number, number, number][] }> = {}
  for (const id of nodeIds) {
    const p = positionAt(id, epoch, simT)
    if (!p) continue
    // GEO sats: tiny trail; LEO: ~1/3 orbit back and forward
    const isGeo = p.alt_km > 20000
    const span = isGeo ? 600 : 1800
    map[id] = { pos: p, trail: trail(id, epoch, simT - span, simT + span, isGeo ? 120 : 20) }
  }
  return map
}
