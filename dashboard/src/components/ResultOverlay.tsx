import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { MOCK, api } from '../lib/sim'
import { fmtT } from './MissionHUD'
import sceneFalse from '../assets/scene_false.jpg'
import sceneTrue from '../assets/scene_true.jpg'

export default function ResultOverlay() {
  const { result, resultOpen, setResultOpen, scenario, spentUsd } = useStore()
  const [trueColor, setTrueColor] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const bbox = scenario?.mission.scene.bbox ?? [-8.5, 139.5, -5.5, 142.5]
  const src = MOCK ? (trueColor ? sceneTrue : sceneFalse) : trueColor ? api.sceneTruecolor() : api.sceneImage()

  useEffect(() => {
    if (!resultOpen) return
    const c = canvas.current, im = img.current
    if (!c || !im) return
    const draw = () => {
      const w = (c.width = im.clientWidth), h = (c.height = im.clientHeight)
      const g = c.getContext('2d')!
      g.clearRect(0, 0, w, h)
      const [s, wlon, n, elon] = bbox
      const X = (lon: number) => ((lon - wlon) / (elon - wlon)) * w
      const Y = (lat: number) => ((n - lat) / (n - s)) * h
      const feats = result?.geojson?.features ?? []
      for (const f of feats) {
        if (f.geometry?.type === 'Point') {
          const [lon, lat] = f.geometry.coordinates
          g.fillStyle = 'rgba(255,120,60,0.75)'
          g.beginPath(); g.arc(X(lon), Y(lat), 2.2, 0, Math.PI * 2); g.fill()
        }
      }
      for (const f of feats) {
        if (f.geometry?.type === 'Polygon') {
          const ring = f.geometry.coordinates[0]
          g.beginPath()
          ring.forEach(([lon, lat]: number[], i: number) => (i ? g.lineTo(X(lon), Y(lat)) : g.moveTo(X(lon), Y(lat))))
          g.closePath()
          g.strokeStyle = '#ffd166'; g.lineWidth = 2; g.setLineDash([6, 4]); g.stroke(); g.setLineDash([])
          g.fillStyle = 'rgba(255,209,102,0.12)'; g.fill()
          const lab = f.properties?.id ?? ''
          if (lab && (f.properties?.detections ?? 0) >= 20) { g.font = '11px monospace'; g.fillStyle = '#ffd166'; g.fillText(`${lab} · ${f.properties?.detections ?? ''}`, X(ring[0][0]) + 4, Y(ring[0][1]) - 4) }
        }
      }
    }
    if (im.complete) draw()
    im.onload = draw
    const ro = new ResizeObserver(draw); ro.observe(im)
    return () => ro.disconnect()
  }, [resultOpen, result, trueColor, bbox, src])

  if (!resultOpen || !result) return null
  const sm = result.summary ?? {}
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 backdrop-blur-sm" onClick={() => setResultOpen(false)}>
      <div className="panel p-4 w-[min(1100px,92vw)] max-h-[88vh] flex gap-4 slide-in" onClick={(e) => e.stopPropagation()}>
        <div className="relative flex-1 min-w-0 rounded-md overflow-hidden border border-line bg-black flex items-center justify-center">
          <div className="relative inline-block">
            <img ref={img} src={src} alt="scene" className="block max-h-[76vh] max-w-full h-auto w-auto" />
            <canvas ref={canvas} className="absolute inset-0 pointer-events-none" />
          </div>
          <div className="absolute top-2 left-2 flex gap-1">
            <button className={`btn ${!trueColor ? 'active' : ''}`} onClick={() => setTrueColor(false)}>SWIR false color</button>
            <button className={`btn ${trueColor ? 'active' : ''}`} onClick={() => setTrueColor(true)}>True color</button>
          </div>
          <div className="absolute bottom-2 left-2 text-[10px] font-mono text-dim bg-black/50 px-2 py-1 rounded">VIIRS SNPP · NASA GIBS · {scenario?.epoch_utc.slice(0, 10)} · bbox {bbox.join(', ')}</div>
        </div>
        <div className="w-[300px] flex flex-col gap-3">
          <div>
            <div className="panel-title">Delivered · fire-perimeter assessment</div>
            <div className="num text-[26px] text-ok mt-2">{fmtT(result.delivered_sim_t ?? 0)}</div>
            <div className="text-[11px] text-dim font-mono">to {result.delivered_to ?? 'ground'} · {scenario ? `${scenario.mission.deadline_sim_t - (result.delivered_sim_t ?? 0)}s before deadline` : ''}</div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <K label="active fronts" v={sm.active_fronts ?? sm.clusters ?? '—'} />
            <K label="fire pixels" v={sm.fire_pixels ?? '—'} />
            <K label="max FRP proxy" v={sm.max_frp_proxy ?? '—'} />
            <K label="output" v={sm.output_kb != null ? `${sm.output_kb} KB` : '—'} />
            <K label="compute" v={sm.compute_s != null ? `${sm.compute_s}s` : '—'} />
            <K label="spent" v={`$${spentUsd.toFixed(2)}`} />
          </div>
          <div className="text-[10.5px] text-dim leading-snug">
            Result produced on an independently operated node under a signed, payment-bound Grant and returned with a signed Usage Attestation. Receipt · Grant · Attestation reconcile.
          </div>
          {result.thumbnail_b64 && <img src={`data:image/png;base64,${result.thumbnail_b64}`} className="rounded border border-line" alt="thumb" />}
          <div className="flex-1" />
          <button className="btn" onClick={() => setResultOpen(false)}>close</button>
        </div>
      </div>
    </div>
  )
}

function K({ label, v }: { label: string; v: any }) {
  return (
    <div className="rounded border border-line px-2 py-1.5 bg-white/[0.02]">
      <div className="text-[9px] font-mono text-dim tracking-widest uppercase">{label}</div>
      <div className="num text-[14px]">{String(v)}</div>
    </div>
  )
}
