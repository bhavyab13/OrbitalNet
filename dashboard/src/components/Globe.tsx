import { useEffect, useMemo, useRef, useState } from 'react'
import GlobeGL, { type GlobeMethods } from 'react-globe.gl'
import * as THREE from 'three'
import { useStore } from '../store'
import { useFx, BUYER_ID, BUYER_POS, GOLD, fxNow } from '../fx'
import { startFxLayer } from './FxLayer'
import type { ContactWindow, NodeLive, Position } from '../types'

const R = 6371
/** Display altitude in globe radii; GEO compressed so it stays in frame. */
export const dispAlt = (altKm: number) => (altKm > 20000 ? 0.85 + 0.15 * Math.min(1, (altKm - 20000) / 20000) : altKm / R)

function interpPos(n: NodeLive, simT: number): Position | undefined {
  if (n.trail && n.trailT && n.trailT.length > 1) {
    const T = n.trailT
    if (simT <= T[0]) return { lat: n.trail[0][0], lon: n.trail[0][1], alt_km: n.trail[0][2] }
    for (let i = 1; i < T.length; i++) {
      if (simT <= T[i]) {
        const f = (simT - T[i - 1]) / (T[i] - T[i - 1] || 1)
        const a = n.trail[i - 1], b = n.trail[i]
        let dlon = b[1] - a[1]
        if (dlon > 180) dlon -= 360
        if (dlon < -180) dlon += 360
        return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + dlon * f, alt_km: a[2] + (b[2] - a[2]) * f }
      }
    }
    const l = n.trail[n.trail.length - 1]
    return { lat: l[0], lon: l[1], alt_km: l[2] }
  }
  return n.pos
}

function glowTexture(color: string) {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grd.addColorStop(0, '#ffffff')
  grd.addColorStop(0.18, color)
  grd.addColorStop(0.45, color + '66')
  grd.addColorStop(1, color + '00')
  g.fillStyle = grd
  g.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(c)
}
const texCache: Record<string, THREE.Texture> = {}
const tex = (color: string) => (texCache[color] ??= glowTexture(color))

function satSprite(d: any) {
  const grp = new THREE.Group()
  const m = new THREE.SpriteMaterial({ map: tex(d.color), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: d.online ? 1 : 0.35 })
  const s = new THREE.Sprite(m)
  const size = d.kind === 'particle' ? 5 : d.active ? 11 : 8
  s.scale.set(size, size, 1)
  grp.add(s)
  if (d.kind === 'sat') {
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 10), new THREE.MeshBasicMaterial({ color: '#ffffff' }))
    grp.add(core)
  }
  return grp
}

function angDeg(a: Position, b: Position) {
  const r = Math.PI / 180
  const d = Math.sin(a.lat * r) * Math.sin(b.lat * r) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.cos((a.lon - b.lon) * r)
  return Math.acos(Math.max(-1, Math.min(1, d))) / r
}

function lerpPos(a: Position, b: Position, f: number): Position {
  let dlon = b.lon - a.lon
  if (dlon > 180) dlon -= 360
  if (dlon < -180) dlon += 360
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + dlon * f, alt_km: a.alt_km + (b.alt_km - a.alt_km) * f }
}

export default function Globe() {
  const ref = useRef<GlobeMethods | undefined>(undefined)
  const wrap = useRef<HTMLDivElement>(null)
  const scenario = useStore((s) => s.scenario)
  const nodes = useStore((s) => s.nodes)
  const windows = useStore((s) => s.windows)
  const transfers = useStore((s) => s.transfers)
  const hotspots = useStore((s) => s.hotspots)
  const simT = useStore((s) => s.simT)
  const status = useStore((s) => s.status)
  const focusLink = useStore((s) => s.focusLink)
  const currentLeg = useStore((s) => s.currentLegIndex)
  const plans = useStore((s) => s.plans)
  const cue = useFx((s) => s.cue)
  const bursts = useFx((s) => s.bursts)
  const resultGeo = useFx((s) => s.resultGeo)
  const posRef = useRef<Record<string, Position>>({})
  const lastUserDrag = useRef(0)
  const [ready, setReady] = useState(false)

  const gsMap = useMemo(() => Object.fromEntries((scenario?.ground_stations ?? []).map((g) => [g.gs_id, g])), [scenario])
  const nodeMeta = useMemo(() => Object.fromEntries((scenario?.nodes ?? []).map((n) => [n.node_id, n])), [scenario])
  const nodeMetaRef = useRef(nodeMeta)
  nodeMetaRef.current = nodeMeta

  // Resolve current positions (interpolated along trails in live mode)
  const pos = useMemo(() => {
    const out: Record<string, Position> = {}
    for (const [id, n] of Object.entries(nodes)) {
      const p = interpPos(n, simT)
      if (p) out[id] = p
    }
    for (const [id, g] of Object.entries(gsMap)) out[id] = { lat: g.lat, lon: g.lon, alt_km: 0 }
    out[BUYER_ID] = BUYER_POS
    posRef.current = out
    return out
  }, [nodes, simT, gsMap])

  const activeNodes = useMemo(() => {
    const set = new Set<string>()
    if (focusLink) { set.add(focusLink[0]); set.add(focusLink[1]) }
    return set
  }, [focusLink])

  // Satellites + transfer particles as sprites
  const objects = useMemo(() => {
    const arr: any[] = []
    for (const [id, n] of Object.entries(nodes)) {
      const p = pos[id]
      if (!p) continue
      arr.push({ id, kind: 'sat', lat: p.lat, lng: p.lon, alt: dispAlt(p.alt_km), color: nodeMeta[id]?.color ?? '#9ad', online: n.online, active: activeNodes.has(id) })
    }
    for (const t of Object.values(transfers)) {
      if (t.done || t.pct >= 100) continue
      const a = pos[t.from], b = pos[t.to]
      if (!a || !b) continue
      const f = Math.max(0.02, Math.min(0.98, t.pct / 100))
      const p = lerpPos(a, b, f)
      const bul = Math.sin(Math.PI * f) * 0.04
      arr.push({ id: 'particle-' + t.window_id, kind: 'particle', lat: p.lat, lng: p.lon, alt: dispAlt(p.alt_km) + bul, color: '#ffffff', online: true, active: true })
    }
    return arr
  }, [nodes, pos, transfers, nodeMeta, activeNodes])

  // Orbit trails + delivered result outlines (fire perimeters projected onto the planet)
  const paths = useMemo(() => {
    const arr: any[] = []
    for (const [id, n] of Object.entries(nodes)) {
      if (!n.trail || n.trail.length < 2) continue
      arr.push({ id, color: nodeMeta[id]?.color ?? '#9ad', online: n.online, pts: n.trail.map((p) => [p[0], p[1], dispAlt(p[2])]), stroke: 0.5, dash: 0.02, gap: 0.01, anim: 12000 })
    }
    if (resultGeo) {
      const polys = resultGeo.features.filter((f) => f?.geometry?.type === 'Polygon' || f?.geometry?.type === 'MultiPolygon')
      let i = 0
      for (const f of polys) {
        const rings: number[][][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map((pg: number[][][]) => pg[0])
        for (const ring of rings) arr.push({ id: `fire-${i++}`, color: '#ff8c42', fire: true, pts: ring.map((c: number[]) => [c[1], c[0], 0.008]), stroke: 1.4, dash: 1, gap: 0, anim: 0 })
      }
      if ((resultGeo.fidelity === 'low' || polys.length === 0) && resultGeo.bbox?.length === 4) {
        const [s, w, n, e] = resultGeo.bbox
        arr.push({ id: 'fire-bbox', color: '#fbbf24', fire: true, pts: [[s, w, 0.008], [s, e, 0.008], [n, e, 0.008], [n, w, 0.008], [s, w, 0.008]], stroke: 1.2, dash: 0.08, gap: 0.04, anim: 3000 })
      }
    }
    return arr
  }, [nodes, nodeMeta, resultGeo])

  const resultPoints = useMemo(() => {
    if (!resultGeo) return []
    return resultGeo.features.filter((f) => f?.geometry?.type === 'Point').slice(0, 400).map((f, i) => ({ id: `fp${i}`, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], frp: Number(f.properties?.frp ?? f.properties?.score ?? 1) }))
  }, [resultGeo])

  // Link arcs for every window: dim future, bright open, red killed, faded closed.
  const legWindows = useMemo(() => {
    const chosen = plans.find((p) => p.chosen)
    const set = new Set<string>()
    chosen?.legs.forEach((l) => l.window_id && l.kind === 'transfer' && set.add(l.window_id))
    return set
  }, [plans])

  const arcs = useMemo(() => {
    const arr: any[] = []
    const now = simT
    for (const w of Object.values(windows) as ContactWindow[]) {
      const a = pos[w.from], b = pos[w.to]
      if (!a || !b) continue
      const st = w.status ?? (now < w.start ? 'future' : now > w.end ? 'closed' : 'open')
      if ((st === 'closed' || st === 'future') && !legWindows.has(w.window_id)) continue
      const tr = transfers[w.window_id]
      const color = nodeMeta[w.from]?.color ?? '#9ad'
      const inPlan = legWindows.has(w.window_id)
      let colors: string[]
      let stroke = 0.35
      let dashLen = 0.4, dashGap = 0.1, anim = 0
      if (st === 'killed') { colors = ['#f87171', '#f87171']; stroke = 0.5; dashLen = 0.08; dashGap = 0.08 }
      else if (st === 'open') { colors = [color, '#ffffff']; stroke = tr && !tr.done ? 1.1 : 0.7; dashLen = 0.25; dashGap = 0.12; anim = tr && !tr.done ? 900 : 2200 }
      else if (st === 'future') { colors = inPlan ? [color + 'aa', color + 'aa'] : ['rgba(140,170,210,0.22)', 'rgba(140,170,210,0.22)']; stroke = inPlan ? 0.4 : 0.22; dashLen = 0.05; dashGap = 0.05 }
      else { colors = [color + '55', color + '55']; stroke = 0.25; dashLen = 1; dashGap = 0 }
      const ang = angDeg(a, b)
      const base = Math.max(dispAlt(a.alt_km), dispAlt(b.alt_km))
      const alt = Math.min(0.45, Math.max(base + 0.03, (ang / 180) * 0.9))
      arr.push({ id: w.window_id, startLat: a.lat, startLng: a.lon, startAlt: dispAlt(a.alt_km), endLat: b.lat, endLng: b.lon, endAlt: dispAlt(b.alt_km), alt, colors, stroke, dashLen, dashGap, anim, kind: w.kind, label: `${w.window_id} · ${w.from} → ${w.to} · T+${w.start}–${w.end}s · ${w.bandwidth_mbps} Mbps` })
    }
    return arr
  }, [windows, pos, transfers, nodeMeta, simT, legWindows])

  const labels = useMemo(() => {
    const arr: any[] = []
    for (const [id] of Object.entries(nodes)) {
      const p = pos[id]
      if (!p) continue
      const tr = Object.values(transfers).find((t) => !t.done && (t.from === id || t.to === id))
      const extra = tr ? `  ${Math.round(tr.pct)}%` : ''
      arr.push({ lat: p.lat, lng: p.lon, alt: dispAlt(p.alt_km) + 0.012, text: id + extra, color: nodeMeta[id]?.color ?? '#9ad', size: activeNodes.has(id) ? 1.25 : 0.95 })
    }
    for (const g of Object.values(gsMap)) arr.push({ lat: g.lat, lng: g.lon, alt: 0.012, text: g.name.split(' (')[0].toUpperCase(), color: 'rgba(200,220,245,0.85)', size: 0.75 })
    arr.push({ lat: BUYER_POS.lat, lng: BUYER_POS.lon, alt: 0.012, text: 'EMERGENCY OPS · BUYER', color: GOLD, size: 0.8 })
    const now = fxNow()
    for (const b of Object.values(bursts)) {
      const p = pos[b.node_id]
      if (p && now - b.at < 4500) arr.push({ lat: p.lat + 4.5, lng: p.lon, alt: dispAlt(p.alt_km) + 0.05, text: b.label, color: '#ffffff', size: 1.05 })
    }
    if (resultGeo && resultGeo.fidelity === 'low' && resultGeo.bbox?.length === 4 && now - resultGeo.at < 12000) {
      const [s, w, n, e] = resultGeo.bbox
      arr.push({ lat: (s + n) / 2, lng: (w + e) / 2, alt: 0.03, text: 'LOW-FIDELITY CROP · extent only', color: '#fbbf24', size: 1.0 })
    }
    return arr
  }, [nodes, pos, gsMap, nodeMeta, transfers, activeNodes, bursts, resultGeo, simT])

  const rings = useMemo(() => {
    const active = new Set<string>()
    for (const w of Object.values(windows)) if (w.status === 'open' && gsMap[w.to]) active.add(w.to)
    const out: any[] = Object.values(gsMap).map((g) => ({ lat: g.lat, lng: g.lon, active: active.has(g.gs_id), buyer: false }))
    out.push({ lat: BUYER_POS.lat, lng: BUYER_POS.lon, active: false, buyer: true })
    return out
  }, [gsMap, windows])

  const hex = useMemo(() => hotspots.map((h) => ({ lat: h.lat, lng: h.lon, w: Math.max(1, h.frp) })), [hotspots])

  // Night lights as emissive map
  const material = useMemo(() => {
    const m = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 8, specular: new THREE.Color(0x223344) })
    new THREE.TextureLoader().load('/tex/earth-night.jpg', (t) => { t.colorSpace = THREE.SRGBColorSpace; m.emissiveMap = t; m.emissive = new THREE.Color(0xbfc8d8); m.emissiveIntensity = 0.55; m.needsUpdate = true })
    return m
  }, [])

  // Camera behaviour
  const lastFocus = useRef<string>('')
  useEffect(() => {
    const g = ref.current
    if (!g) return
    const ctl = g.controls() as any
    ctl.enableDamping = true
    ctl.dampingFactor = 0.08
    if (status === 'IDLE') {
      ctl.autoRotate = true
      ctl.autoRotateSpeed = 0.35
    } else {
      ctl.autoRotate = false
    }
  }, [status])

  const userBusy = () => Date.now() - lastUserDrag.current < 8000
  const frameNodes = (ids: string[], ms = 1500) => {
    const g = ref.current
    const a = pos[ids[0]], b = ids[1] ? pos[ids[1]] : undefined
    if (!g || !a) return
    const mid = b ? lerpPos(a, b, 0.5) : a
    const span = b ? Math.hypot(a.lat - b.lat, Math.min(Math.abs(a.lon - b.lon), 360 - Math.abs(a.lon - b.lon))) : 20
    const geo = (a.alt_km > 20000 || (b && b.alt_km > 20000))
    const altitude = geo ? 2.6 : Math.min(2.4, Math.max(1.25, span / 40))
    g.pointOfView({ lat: mid.lat, lng: mid.lon, altitude }, ms)
  }
  useEffect(() => {
    const g = ref.current
    if (!g || !focusLink || userBusy()) return
    const key = focusLink.join('|') + ':' + currentLeg
    if (lastFocus.current === key) return
    lastFocus.current = key
    frameNodes(focusLink, 1600)
  }, [focusLink, currentLeg, pos])

  // Camera choreography per protocol beat (never fights the user: skipped for 8 s after a drag)
  const lastCue = useRef(0)
  useEffect(() => {
    const g = ref.current
    if (!g || !ready || !cue || cue.at === lastCue.current || !scenario) return
    lastCue.current = cue.at
    if (userBusy()) return
    const b = scenario.mission.scene.bbox
    const papua = { lat: (b[0] + b[2]) / 2, lng: (b[1] + b[3]) / 2 }
    const ctl = g.controls() as any
    if (cue.kind === 'papua') { ctl.autoRotate = false; g.pointOfView({ ...papua, altitude: 1.55 }, 1500) }
    else if (cue.kind === 'result') { ctl.autoRotate = false; g.pointOfView({ ...papua, altitude: 1.25 }, 1800) }
    else if (cue.kind === 'link' && cue.nodes) frameNodes(cue.nodes, 1500)
    else if (cue.kind === 'node' && cue.nodes) { const p = pos[cue.nodes[0]]; if (p) g.pointOfView({ lat: p.lat, lng: p.lon, altitude: 1.9 }, 1500) }
    else if (cue.kind === 'pullout') { const cur = g.pointOfView(); g.pointOfView({ lat: cur.lat, lng: cur.lng, altitude: Math.min(3.2, (cur.altitude ?? 2) + 0.7) }, 1500) }
    else if (cue.kind === 'idle') { ctl.autoRotate = true }
  }, [cue, scenario, ready])

  // Initial POV over the scene
  useEffect(() => {
    const g = ref.current
    if (!g || !scenario) return
    const b = scenario.mission.scene.bbox
    g.pointOfView({ lat: (b[0] + b[2]) / 2 - 8, lng: (b[1] + b[3]) / 2 + 10, altitude: 2.1 }, 0)
  }, [scenario])

  // Size tracking
  const [size, setSize] = useState({ w: 800, h: 600 })
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={wrap} className="absolute inset-0">
      <GlobeGL
        ref={ref as any}
        width={size.w}
        height={size.h}
        backgroundColor="rgba(0,0,0,0)"
        backgroundImageUrl="/tex/night-sky.png"
        globeImageUrl="/tex/earth-blue-marble.jpg"
        bumpImageUrl="/tex/earth-topology.png"
        globeMaterial={material}
        showAtmosphere
        atmosphereColor="#5fb3ff"
        atmosphereAltitude={0.22}
        animateIn={false}
        objectsData={objects}
        objectLat="lat"
        objectLng="lng"
        objectAltitude="alt"
        objectThreeObject={satSprite as any}
        objectLabel={(d: any) => (d.kind === 'sat' ? `<div style="font:12px monospace;color:${d.color}">${d.id}</div>` : '')}
        pathsData={paths}
        pathPoints="pts"
        pathPointLat={(p: any) => p[0]}
        pathPointLng={(p: any) => p[1]}
        pathPointAlt={(p: any) => p[2]}
        pathColor={(d: any) => (d.fire ? [d.color, '#ffffff', d.color] : [d.color + '00', d.color + (d.online ? 'cc' : '44'), d.color + '00'])}
        pathStroke={(d: any) => d.stroke ?? 0.5}
        pathDashLength={(d: any) => d.dash ?? 0.02}
        pathDashGap={(d: any) => d.gap ?? 0.01}
        pathDashAnimateTime={(d: any) => d.anim ?? 12000}
        pathTransitionDuration={0}
        pointsData={resultPoints}
        pointLat="lat"
        pointLng="lng"
        pointAltitude={0.012}
        pointRadius={(d: any) => 0.08 + Math.min(0.14, Math.log10(1 + d.frp) * 0.08)}
        pointColor={() => '#ffb347'}
        pointsMerge
        pointsTransitionDuration={0}
        arcsData={arcs}
        arcStartLat="startLat"
        arcStartLng="startLng"
        arcStartAltitude="startAlt"
        arcEndLat="endLat"
        arcEndLng="endLng"
        arcEndAltitude="endAlt"
        arcColor="colors"
        arcAltitude="alt"
        arcStroke="stroke"
        arcDashLength="dashLen"
        arcDashGap="dashGap"
        arcDashAnimateTime="anim"
        arcLabel="label"
        arcsTransitionDuration={0}
        labelsData={labels}
        labelLat="lat"
        labelLng="lng"
        labelAltitude="alt"
        labelText="text"
        labelColor="color"
        labelSize="size"
        labelDotRadius={0.0}
        labelIncludeDot={false}
        labelResolution={2}
        labelsTransitionDuration={0}
        ringsData={rings}
        ringLat="lat"
        ringLng="lng"
        ringAltitude={0.004}
        ringColor={(d: any) => (t: number) => (d.buyer ? `rgba(255,209,102,${0.7 * (1 - t)})` : d.active ? `rgba(79,209,255,${1 - t})` : `rgba(180,200,230,${0.55 * (1 - t)})`)}
        ringMaxRadius={(d: any) => (d.buyer ? 3.2 : d.active ? 5 : 2.6)}
        ringPropagationSpeed={(d: any) => (d.buyer ? 1 : d.active ? 2.2 : 0.8)}
        ringRepeatPeriod={(d: any) => (d.buyer ? 2200 : d.active ? 700 : 1800)}
        hexBinPointsData={hex}
        hexBinPointLat="lat"
        hexBinPointLng="lng"
        hexBinPointWeight="w"
        hexBinResolution={5}
        hexMargin={0.35}
        hexAltitude={(d: any) => 0.004 + Math.min(0.03, Math.log10(1 + d.sumWeight) * 0.012)}
        hexTopColor={(d: any) => (d.sumWeight > 60 ? '#ffd166' : d.sumWeight > 20 ? '#ff8c42' : '#ff5a36')}
        hexSideColor={() => 'rgba(255,90,54,0.35)'}
        hexBinMerge
        hexTransitionDuration={0}
        onGlobeReady={() => {
          const g = ref.current
          if (!g) return
          const ctl = g.controls() as any
          ctl.autoRotate = true
          ctl.autoRotateSpeed = 0.35
          ctl.minDistance = 120
          ctl.maxDistance = 800
          const scene = g.scene()
          scene.add(new THREE.AmbientLight(0x6a7a99, 0.5))
          ctl.addEventListener('start', () => { lastUserDrag.current = Date.now() })
          startFxLayer(g, posRef, (id) => nodeMetaRef.current[id]?.color ?? '#9ad')
          setReady(true)
        }}
      />
    </div>
  )
}
