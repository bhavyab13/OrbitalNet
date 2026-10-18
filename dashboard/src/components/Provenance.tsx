import { useMemo, useState } from 'react'
import { useStore } from '../store'

const NORAD: Record<string, number> = { 'SENTINEL-2A': 40697, 'PHISAT-2': 60470, 'EDRS-C': 44475, 'STARLINK-3005': 48881 }
const OPERATOR_REAL: Record<string, string> = { 'SENTINEL-2A': 'ESA Copernicus', 'PHISAT-2': 'ESA Φsat-2 (onboard AI demo)', 'EDRS-C': 'ESA/Airbus SpaceDataHighway (GEO relay)', 'STARLINK-3005': 'SpaceX Starlink (laser crosslinks)' }

const layerName = (f?: string) => (f ?? '').replace(/^.*papua_/, '').replace(/\.jpg$/, '')

/** What is real and what is modeled — collapsed to one strip, expands on click. */
export default function Provenance() {
  const scenario = useStore((s) => s.scenario)
  const hotspots = useStore((s) => s.hotspots)
  const [open, setOpen] = useState(false)
  const tleDate = useMemo(() => (scenario?.epoch_utc ?? '').slice(0, 10), [scenario])
  const n = hotspots.length
  const fires = n >= 3000 ? n.toLocaleString() : `${n.toLocaleString()}${n < 3000 ? ' (sample)' : ''}`
  if (!scenario) return null
  const sc = scenario.mission.scene
  return (
    <div className="pointer-events-auto">
      <button onClick={() => setOpen(!open)} className="panel px-3 py-1.5 font-mono text-[10px] text-dim tracking-wide text-left hover:text-ink transition-colors">
        <span className="hidden 2xl:inline"><span className="text-ink">REAL</span> · SGP4 orbits (CelesTrak TLE {tleDate}) · VIIRS {fires} fire detections (NASA FIRMS {tleDate}) · NASA GIBS imagery<span className="mx-2 text-line">|</span><span className="text-warn">MODELED</span> · contact windows · bandwidth · power · prices</span>
        <span className="2xl:hidden whitespace-nowrap"><span className="text-ink">REAL</span> · SGP4 orbits · VIIRS {fires} fires · NASA GIBS <span className="mx-1 text-line">|</span> <span className="text-warn">MODELED</span> · windows · prices</span>
        <span className="ml-2 text-dim/60">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="panel mt-1 p-3 text-[10.5px] font-mono max-w-[640px] slide-in">
          <div className="panel-title mb-2">Data provenance</div>
          <table className="w-full text-left">
            <thead className="text-[9px] text-dim tracking-widest"><tr><th className="font-normal pb-1">NODE</th><th className="font-normal pb-1">REAL SPACECRAFT</th><th className="font-normal pb-1">NORAD</th><th className="font-normal pb-1">ROLE HERE</th></tr></thead>
            <tbody>
              {scenario.nodes.map((nd) => (
                <tr key={nd.node_id} className="border-t border-line/60">
                  <td className="py-1 pr-2" style={{ color: nd.color }}>{nd.node_id}</td>
                  <td className="py-1 pr-2 text-ink/85">{OPERATOR_REAL[nd.node_id] ?? nd.tle_name}</td>
                  <td className="py-1 pr-2 num text-dim">{NORAD[nd.node_id] ?? '—'}</td>
                  <td className="py-1 text-dim">{nd.role} · {nd.operator_name.replace(/ \(.*\)/, '')} (fictional operator)</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-dim">
            <span className="text-ink/80">Orbits</span><span>SGP4 propagation of CelesTrak TLEs (epoch {scenario.epoch_utc}); positions on the globe are real, GEO altitude display-compressed.</span>
            <span className="text-ink/80">Fires</span><span>NASA FIRMS VIIRS (Suomi-NPP C2) active-fire detections, last 24 h on {tleDate}; {fires} inside bbox [{sc.bbox.join(', ')}].</span>
            <span className="text-ink/80">Imagery</span><span>NASA GIBS {layerName(sc.image_file)} (SWIR false colour) + {layerName(sc.truecolor_file)}; the inference runs on this scene.</span>
            <span className="text-ink/80">Inference</span><span>SWIR-anomaly fire detector on the real scene; validated against the VIIRS hotspots.</span>
            <span className="text-warn">Modeled</span><span>contact windows, link bandwidths, onboard power budgets, scarcity prices, payload sizes — scenario values, not measured telemetry.</span>
            <span className="text-ink/80">Payments</span><span>Real MPP 402 challenges; Tempo testnet / Stripe sandbox receipts. No real money.</span>
          </div>
        </div>
      )}
    </div>
  )
}
