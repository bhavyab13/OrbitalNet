/**
 * 60 fps protocol-object layer drawn straight into the globe's three.js scene:
 * grant rings around providers, money beams (MPP payments / refunds / metered sparks), data-link beams while bytes move,
 * late-provider shockwave, spacecraft orientation + point-flare pulses.
 * Reads positions from a ref the Globe component keeps current; protocol state from the fx + main stores.
 */
import * as THREE from 'three'
import type { GlobeMethods } from 'react-globe.gl'
import { useFx, BUYER_ID, GOLD, fxNow, type MoneyParticle } from '../fx'
import { useStore } from '../store'
import { dispAlt } from '../lib/globeReg'
import { glowTex } from '../lib/cinema'
import { Beam } from './Beams'
import type { Position } from '../types'

type PosMap = Record<string, Position>

const RING_COLORS = { fulfilled: '#34d399', revoked: '#f87171' }

function ringTexture(color: string, dashed: boolean) {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')!
  g.clearRect(0, 0, 256, 256)
  g.shadowColor = color
  g.shadowBlur = 18
  g.strokeStyle = color
  g.lineWidth = 7
  if (dashed) g.setLineDash([14, 11])
  g.beginPath(); g.arc(128, 128, 96, 0, Math.PI * 2); g.stroke()
  g.shadowBlur = 0
  g.lineWidth = 2.5
  g.strokeStyle = '#ffffff'
  g.globalAlpha = 0.85
  g.beginPath(); g.arc(128, 128, 96, 0, Math.PI * 2); g.stroke()
  // tick marks make it read as an instrument, not a circle
  g.globalAlpha = 0.9; g.lineWidth = 3; g.setLineDash([])
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; g.beginPath(); g.moveTo(128 + Math.cos(a) * 104, 128 + Math.sin(a) * 104); g.lineTo(128 + Math.cos(a) * (i % 3 ? 110 : 118), 128 + Math.sin(a) * (i % 3 ? 110 : 118)); g.stroke() }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
const texCache: Record<string, THREE.Texture> = {}
const ringTex = (color: string, dashed: boolean) => (texCache[`r${color}${dashed}`] ??= ringTexture(color, dashed))

const sprite = (tex: THREE.Texture, size: number, opacity = 1) => {
  const m = new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity })
  const s = new THREE.Sprite(m)
  s.scale.set(size, size, 1)
  return s
}

function lerpPos(a: Position, b: Position, f: number): Position {
  let dlon = b.lon - a.lon
  if (dlon > 180) dlon -= 360
  if (dlon < -180) dlon += 360
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + dlon * f, alt_km: a.alt_km + (b.alt_km - a.alt_km) * f }
}
const ease = (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t)
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

export function startFxLayer(globe: GlobeMethods, posRef: { current: PosMap }, colorOf: (nodeId: string) => string) {
  const group = new THREE.Group()
  group.name = 'ocgp-fx'
  globe.scene().add(group)
  const ringSprites = new Map<string, { s: THREE.Sprite; state: string }>()
  const beams = new Map<string, Beam>()
  const burstSprites = new Map<string, THREE.Sprite[]>()
  const toXYZ = (p: Position, extraAlt = 0) => {
    const c = (globe as any).getCoords(p.lat, p.lon, dispAlt(p.alt_km) + extraAlt)
    return new THREE.Vector3(c.x, c.y, c.z)
  }
  /** Lifted path between two positions: bulges away from the planet so beams never clip the terrain. */
  const path = (a: Position, b: Position, bulge: number, n = 24) => {
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= n; i++) { const f = i / n; pts.push(toXYZ(lerpPos(a, b, f), Math.sin(Math.PI * f) * bulge)) }
    return pts
  }
  const beamFor = (id: string, color: string, o: Partial<ConstructorParameters<typeof Beam>[0]> = {}) => {
    let b = beams.get(id)
    if (!b) { b = new Beam({ color, ...o }); group.add(b.group); beams.set(id, b) }
    return b
  }
  const dropBeam = (id: string) => { const b = beams.get(id); if (b) { group.remove(b.group); b.dispose(); beams.delete(id) } }

  let raf = 0
  let stopped = false
  const sats: THREE.Group[] = []
  let satScanAt = 0

  const frame = () => {
    if (stopped) return
    raf = requestAnimationFrame(frame)
    const now = fxNow()
    const fx = useFx.getState()
    const st = useStore.getState()
    const pos = posRef.current

    // ---- spacecraft: keep nadir face toward the planet, slow roll, pulse the point flare
    if (now - satScanAt > 1500) {
      satScanAt = now
      sats.length = 0
      globe.scene().traverse((o) => { if (o.userData?.sat) sats.push(o as THREE.Group) })
    }
    const active = new Set<string>(st.focusLink ?? [])
    if (st.committedNode) active.add(st.committedNode)
    for (const s of sats) {
      if (!s.parent) continue
      s.lookAt(0, 0, 0)
      s.rotateZ(now / 9000 + s.userData.phase)
      const isActive = active.has(s.userData.id)
      const flare = s.getObjectByName('flare') as THREE.Sprite | undefined
      if (flare) {
        const geo = (pos[s.userData.id]?.alt_km ?? 0) > 20000 // GEO is display-compressed toward the camera: keep its flare modest
        const k = (isActive ? 9 : 7) * (geo ? 0.5 : 1) * (1 + 0.18 * Math.sin(now / 180 + s.userData.phase))
        flare.scale.set(k, k, 1)
        ;(flare.material as THREE.SpriteMaterial).opacity = isActive ? 0.85 : 0.7
      }
    }

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
        ;(s.material as THREE.SpriteMaterial).depthTest = false
        group.add(s)
        rec = { s, state: key }
        ringSprites.set(r.grant_id, rec)
      }
      const siblings = Object.values(fx.rings).filter((x) => x.node_id === r.node_id && x.state !== 'revoked').sort((a, b) => a.at - b.at)
      const idx = Math.max(0, siblings.findIndex((x) => x.grant_id === r.grant_id))
      const base = 20 + idx * 7
      const pulse = r.state === 'issued' ? 1 + 0.1 * Math.sin(now / 260) : 1
      const grow = Math.min(1, (now - r.at) / 600)
      const sc = base * pulse * easeOut(grow)
      rec.s.scale.set(sc, sc, 1)
      rec.s.material.rotation = (r.state === 'issued' ? now / 4000 : -now / 9000) + idx
      const mat = rec.s.material as THREE.SpriteMaterial
      mat.opacity = r.state === 'revoked' ? Math.max(0, 1 - age / 3200) : r.state === 'issued' ? 0.75 + 0.25 * Math.sin(now / 260) : 0.95
      rec.s.position.copy(toXYZ(p))
    }
    for (const [id, rec] of ringSprites) if (!live.has(id)) { group.remove(rec.s); ringSprites.delete(id) }

    // ---- money beams (pay / refund / metered sparks)
    const liveB = new Set<string>()
    let prune = false
    for (const pt of fx.particles) {
      const total = pt.kind === 'spark' ? pt.dur : pt.dur * 1.9
      const f = (now - pt.at) / total
      if (f > 1) { prune = true; continue }
      const a = pos[pt.from], b = pos[pt.to]
      if (!a || !b) continue
      liveB.add(pt.id)
      const spark = pt.kind === 'spark'
      const color = pt.kind === 'refund' ? '#ffb347' : GOLD
      const beam = beamFor(pt.id, color, spark ? { coreRadius: 0.08, glowRadius: 0.35, packets: 10, speed: 0.004 } : { packets: 7, speed: 0.0022, coreRadius: 0.1, glowRadius: 0.5 })
      const bulge = spark ? 0.06 : 0.16
      const pts = path(a, b, bulge)
      // phase 1 (0..dur): head travels a→b; phase 2: hold + arrival flash; phase 3: tail retracts into b
      const t = now - pt.at
      let head = 1, tail = 0, alpha = 1, hit = 0
      if (t < pt.dur) head = ease(t / pt.dur)
      else {
        const t2 = (t - pt.dur) / (total - pt.dur)
        hit = Math.min(1, t2 / 0.45)
        tail = t2 < 0.25 ? 0 : ease((t2 - 0.25) / 0.75)
        alpha = 1 - Math.pow(Math.max(0, t2 - 0.6) / 0.4, 2)
      }
      beam.update(pts, head, tail, spark ? 0.8 : alpha, now, spark ? 0 : hit)
    }
    if (prune) useFx.setState({ particles: fx.particles.filter((p) => (now - p.at) / (p.kind === 'spark' ? p.dur : p.dur * 1.9) <= 1) })

    // ---- data-link beams: lit while bytes move over an open window, retract when the transfer completes
    for (const tr of Object.values(st.transfers)) {
      const a = pos[tr.from], b = pos[tr.to]
      if (!a || !b) continue
      const id = `tr:${tr.window_id}`
      const doneAt = (tr as any).__doneAt
      if (tr.done || tr.pct >= 100) {
        if (!doneAt) (tr as any).__doneAt = now
        const age = now - ((tr as any).__doneAt ?? now)
        if (age > 1400) continue
        liveB.add(id)
        const beam = beamFor(id, colorOf(tr.from), { packets: 9, speed: 0.003, coreRadius: 0.12, glowRadius: 0.6 })
        beam.update(path(a, b, 0.08), 1, ease(Math.min(1, age / 1400)), 1 - age / 1400, now, Math.min(1, age / 900))
        continue
      }
      liveB.add(id)
      const beam = beamFor(id, colorOf(tr.from), { packets: 9, speed: 0.003, coreRadius: 0.12, glowRadius: 0.6 })
      const f = Math.max(0.03, Math.min(1, tr.pct / 100))
      beam.update(path(a, b, 0.08), 1, 0, 0.75 + 0.25 * Math.sin(now / 120), now, f > 0.95 ? 0 : 0)
    }
    // metered downlink: keep a faint beam alive between the metered endpoints
    if (fx.activeMetered) {
      const a = pos[fx.activeMetered.from], b = pos[fx.activeMetered.to]
      if (a && b) { liveB.add('metered'); beamFor('metered', GOLD, { packets: 12, speed: 0.0035, coreRadius: 0.08, glowRadius: 0.4 }).update(path(a, b, 0.08), 1, 0, 0.55, now, 0) }
    }
    for (const id of [...beams.keys()]) if (!liveB.has(id)) dropBeam(id)

    // ---- late provider: shockwave rings + flash
    for (const [nid, b] of Object.entries(fx.bursts)) {
      const p = pos[nid]
      const age = now - b.at
      if (!p) continue
      if (age > 2600) { const arr = burstSprites.get(nid); if (arr) { arr.forEach((s) => group.remove(s)); burstSprites.delete(nid) } continue }
      let arr = burstSprites.get(nid)
      if (!arr) { arr = [sprite(ringTex('#ffffff', false), 4), sprite(ringTex(colorOf(nid), false), 4), sprite(glowTex('#ffffff', 128), 4)]; arr.forEach((s) => { (s.material as THREE.SpriteMaterial).depthTest = false; group.add(s) }); burstSprites.set(nid, arr) }
      const xyz = toXYZ(p)
      arr.forEach((s, i) => {
        const d = i === 2 ? 0 : i * 350
        const f = Math.max(0, Math.min(1, (age - d) / (i === 2 ? 700 : 1900)))
        const size = i === 2 ? 6 + 30 * (1 - f) : 4 + 64 * easeOut(f)
        s.scale.set(size, size, 1)
        ;(s.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - f) * (i === 2 ? 1 : 0.9)
        s.position.copy(xyz)
      })
    }
  }
  frame()

  return () => {
    stopped = true
    cancelAnimationFrame(raf)
    for (const b of beams.values()) b.dispose()
    globe.scene().remove(group)
  }
}

export { BUYER_ID }
export type { MoneyParticle }
