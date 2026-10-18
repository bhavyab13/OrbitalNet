/**
 * 60 fps protocol-object layer drawn straight into the globe's three.js scene:
 * grant rings around providers, gold money particles, late-provider burst, metered sparks.
 * Reads positions from a ref the Globe component keeps current; reads protocol state from the fx store.
 */
import * as THREE from 'three'
import type { GlobeMethods } from 'react-globe.gl'
import { useFx, BUYER_ID, GOLD, fxNow, type MoneyParticle } from '../fx'
import type { Position } from '../types'

type PosMap = Record<string, Position>

const RING_COLORS = { fulfilled: '#34d399', revoked: '#f87171' }

function ringTexture(color: string, dashed: boolean) {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')!
  g.clearRect(0, 0, 256, 256)
  // soft glow
  g.shadowColor = color
  g.shadowBlur = 18
  g.strokeStyle = color
  g.lineWidth = 7
  if (dashed) g.setLineDash([14, 11])
  g.beginPath()
  g.arc(128, 128, 96, 0, Math.PI * 2)
  g.stroke()
  g.shadowBlur = 0
  g.lineWidth = 2.5
  g.strokeStyle = '#ffffff'
  g.globalAlpha = 0.85
  g.beginPath()
  g.arc(128, 128, 96, 0, Math.PI * 2)
  g.stroke()
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
function dotTexture(color: string) {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grd.addColorStop(0, '#ffffff')
  grd.addColorStop(0.25, color)
  grd.addColorStop(0.6, color + '77')
  grd.addColorStop(1, color + '00')
  g.fillStyle = grd
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}
const texCache: Record<string, THREE.Texture> = {}
const ringTex = (color: string, dashed: boolean) => (texCache[`r${color}${dashed}`] ??= ringTexture(color, dashed))
const dotTex = (color: string) => (texCache[`d${color}`] ??= dotTexture(color))

const sprite = (tex: THREE.Texture, size: number, opacity = 1) => {
  const m = new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity })
  const s = new THREE.Sprite(m)
  s.scale.set(size, size, 1)
  return s
}

const dispAlt = (altKm: number) => (altKm > 20000 ? 0.85 + 0.15 * Math.min(1, (altKm - 20000) / 20000) : altKm / 6371)

function lerpPos(a: Position, b: Position, f: number): Position {
  let dlon = b.lon - a.lon
  if (dlon > 180) dlon -= 360
  if (dlon < -180) dlon += 360
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + dlon * f, alt_km: a.alt_km + (b.alt_km - a.alt_km) * f }
}
const ease = (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t)

export function startFxLayer(globe: GlobeMethods, posRef: { current: PosMap }, colorOf: (nodeId: string) => string) {
  const group = new THREE.Group()
  group.name = 'ocgp-fx'
  globe.scene().add(group)
  const ringSprites = new Map<string, { s: THREE.Sprite; state: string }>()
  const particleSprites = new Map<string, THREE.Sprite[]>()
  const burstSprites = new Map<string, THREE.Sprite>()
  const toXYZ = (p: Position, extraAlt = 0) => {
    const c = (globe as any).getCoords(p.lat, p.lon, dispAlt(p.alt_km) + extraAlt)
    return new THREE.Vector3(c.x, c.y, c.z)
  }
  let raf = 0
  let stopped = false

  const frame = () => {
    if (stopped) return
    raf = requestAnimationFrame(frame)
    const now = fxNow()
    const fx = useFx.getState()
    const pos = posRef.current

    // ---- grant rings
    const live = new Set<string>()
    for (const r of Object.values(fx.rings)) {
      const p = pos[r.node_id]
      if (!p) continue
      const age = now - r.stateAt
      if (r.state === 'revoked' && age > 3200) continue
      live.add(r.grant_id)
      const color = r.state === 'issued' ? colorOf(r.node_id) : RING_COLORS[r.state]
      const key = `${color}|${r.state === 'revoked'}`
      let rec = ringSprites.get(r.grant_id)
      if (!rec || rec.state !== key) {
        if (rec) group.remove(rec.s)
        const s = sprite(ringTex(color, r.state === 'revoked'), 18)
        group.add(s)
        rec = { s, state: key }
        ringSprites.set(r.grant_id, rec)
      }
      // second ring on the same node sits slightly larger
      const siblings = Object.values(fx.rings).filter((x) => x.node_id === r.node_id && x.state !== 'revoked').sort((a, b) => a.at - b.at)
      const idx = Math.max(0, siblings.findIndex((x) => x.grant_id === r.grant_id))
      const base = 18 + idx * 6
      const pulse = r.state === 'issued' ? 1 + 0.12 * Math.sin(now / 260) : 1
      const grow = Math.min(1, (now - r.at) / 500)
      rec.s.scale.set(base * pulse * ease(grow), base * pulse * ease(grow), 1)
      const mat = rec.s.material as THREE.SpriteMaterial
      mat.opacity = r.state === 'revoked' ? Math.max(0, 1 - age / 3200) : r.state === 'issued' ? 0.75 + 0.25 * Math.sin(now / 260) : 0.95
      rec.s.position.copy(toXYZ(p))
    }
    for (const [id, rec] of ringSprites) if (!live.has(id)) { group.remove(rec.s); ringSprites.delete(id) }

    // ---- money particles (+ metered sparks)
    const liveP = new Set<string>()
    let prune = false
    for (const pt of fx.particles) {
      const f = (now - pt.at) / pt.dur
      if (f > 1.15) { prune = true; continue }
      const a = pos[pt.from], b = pos[pt.to]
      if (!a || !b) continue
      liveP.add(pt.id)
      let arr = particleSprites.get(pt.id)
      if (!arr) {
        const color = pt.kind === 'refund' ? GOLD : GOLD
        const n = pt.kind === 'spark' ? 1 : 4
        arr = Array.from({ length: n }, (_, i) => sprite(dotTex(color), (pt.kind === 'spark' ? 2.6 : i === 0 ? 5.5 : 3.6 - i * 0.6), i === 0 ? 1 : 0.55 - i * 0.12))
        for (const s of arr) group.add(s)
        particleSprites.set(pt.id, arr)
      }
      arr.forEach((s, i) => {
        const ff = Math.max(0, Math.min(1, ease(Math.min(1, f)) - i * 0.045))
        const p = lerpPos(a, b, ff)
        const bul = pt.kind === 'spark' ? 0.02 : Math.sin(Math.PI * ff) * 0.18
        s.position.copy(toXYZ(p, bul))
        const fade = f > 1 ? Math.max(0, 1 - (f - 1) / 0.15) : 1
        ;(s.material as THREE.SpriteMaterial).opacity = (i === 0 ? 1 : 0.55 - i * 0.12) * fade
      })
    }
    for (const [id, arr] of particleSprites) if (!liveP.has(id)) { for (const s of arr) group.remove(s); particleSprites.delete(id) }
    if (prune) useFx.setState({ particles: fx.particles.filter((p) => (now - p.at) / p.dur <= 1.15) })

    // ---- late provider burst
    for (const [nid, b] of Object.entries(fx.bursts)) {
      const p = pos[nid]
      const age = now - b.at
      if (!p) continue
      if (age > 1800) { const s = burstSprites.get(nid); if (s) { group.remove(s); burstSprites.delete(nid) } continue }
      let s = burstSprites.get(nid)
      if (!s) { s = sprite(ringTex('#ffffff', false), 4); group.add(s); burstSprites.set(nid, s) }
      const f = age / 1800
      const size = 4 + 40 * ease(f)
      s.scale.set(size, size, 1)
      ;(s.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - f) * 0.9
      s.position.copy(toXYZ(p))
    }
  }
  frame()

  return () => {
    stopped = true
    cancelAnimationFrame(raf)
    globe.scene().remove(group)
  }
}

export { BUYER_ID }
export type { MoneyParticle }
