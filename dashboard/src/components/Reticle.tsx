/**
 * HUD target-lock overlay: projects the spacecraft / ground stations of the active link into screen space and draws
 * instrument brackets with live telemetry next to them. Pure DOM, updated per frame (no React re-render).
 */
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import { useFx, fxNow } from '../fx'
import { globeReg, dispAlt } from '../lib/globeReg'

const GLOBE_R = 100
const tmp = new THREE.Vector3(), cam = new THREE.Vector3(), d = new THREE.Vector3()

function occluded(p: THREE.Vector3, c: THREE.Vector3) {
  d.subVectors(p, c)
  const t = -c.dot(d) / d.lengthSq()
  if (t <= 0 || t >= 1) return false
  tmp.copy(c).addScaledVector(d, t)
  return tmp.length() < GLOBE_R * 0.995
}

export default function Reticle() {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = host.current!
    const els = new Map<string, HTMLDivElement>()
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const g = globeReg.globe
      if (!g) return
      const st = useStore.getState()
      const fx = useFx.getState()
      const now = fxNow()
      const ids = new Set<string>(st.focusLink ?? [])
      if (st.committedNode) ids.add(st.committedNode)
      for (const b of Object.values(fx.bursts)) if (now - b.at < 6000) ids.add(b.node_id)
      for (const p of fx.particles) if (p.kind !== 'spark' && now - p.at < p.dur * 2.2) { ids.add(p.to); ids.add(p.from) }
      const camera = g.camera()
      camera.getWorldPosition(cam)
      const w = el.clientWidth, h = el.clientHeight
      const meta = Object.fromEntries((st.scenario?.nodes ?? []).map((n) => [n.node_id, n]))
      const gs = Object.fromEntries((st.scenario?.ground_stations ?? []).map((n) => [n.gs_id, n]))
      const seen = new Set<string>()
      for (const id of ids) {
        const p = globeReg.pos.current[id]
        if (!p) continue
        const c = (g as any).getCoords(p.lat, p.lon, dispAlt(p.alt_km))
        tmp.set(c.x, c.y, c.z)
        if (occluded(tmp, cam)) continue
        tmp.project(camera)
        if (tmp.z > 1) continue
        const x = ((tmp.x + 1) / 2) * w, y = ((1 - tmp.y) / 2) * h
        if (x < -50 || y < -50 || x > w + 50 || y > h + 50) continue
        seen.add(id)
        let node = els.get(id)
        const m = meta[id]
        const color = m?.color ?? (gs[id] ? '#bfe0ff' : '#ffd166')
        if (!node) {
          node = document.createElement('div')
          node.className = 'reticle'
          node.style.setProperty('--c', color)
          node.innerHTML = `<i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i><div class="tag"><b></b><span></span></div>`
          el.appendChild(node)
          els.set(id, node)
        }
        const tr = Object.values(st.transfers).find((t) => !t.done && (t.from === id || t.to === id))
        const role = m ? m.role.toUpperCase() : gs[id] ? 'GROUND' : 'OPS'
        const alt = p.alt_km > 0 ? `${p.alt_km >= 10000 ? (p.alt_km / 1000).toFixed(1) + 'k' : Math.round(p.alt_km)} km` : `${p.lat.toFixed(1)}° ${p.lon.toFixed(1)}°`
        const line = tr ? `${role} · ${tr.from === id ? 'TX' : 'RX'} ${Math.round(tr.pct)}% · ${tr.bytes_total_mb >= 1 ? tr.bytes_total_mb + ' MB' : Math.round(tr.bytes_total_mb * 1000) + ' KB'}` : `${role} · ${alt}${st.committedNode === id ? ' · RESULT HELD' : ''}`
        const sz = m ? (p.alt_km > 20000 ? 74 : 58) : 44
        node.style.transform = `translate(${x - sz / 2}px, ${y - sz / 2}px)`
        node.style.width = node.style.height = `${sz}px`
        const b = node.querySelector('b')!, s = node.querySelector('span')!
        if (b.textContent !== id) b.textContent = id
        if (s.textContent !== line) s.textContent = line
        node.style.opacity = '1'
      }
      for (const [id, n] of els) if (!seen.has(id)) { n.style.opacity = '0' }
    }
    tick()
    return () => { cancelAnimationFrame(raf); el.innerHTML = '' }
  }, [])
  return <div ref={host} className="absolute inset-0 pointer-events-none z-[6] overflow-hidden" />
}
