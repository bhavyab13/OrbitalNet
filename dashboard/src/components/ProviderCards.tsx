import { useStore } from '../store'

export default function ProviderCards() {
  const scenario = useStore((s) => s.scenario)
  const nodes = useStore((s) => s.nodes)
  const committed = useStore((s) => s.committedNode)
  if (!scenario) return null
  const list = scenario.nodes.filter((n) => n.role !== 'imaging' || true)
  return (
    <div className="panel p-3 flex flex-col gap-2 flex-1 min-h-0">
      <div className="panel-title">Operators · independent nodes</div>
      <div className="flex flex-col gap-2 scroll min-h-0">
        {list.map((n) => {
          const live = nodes[n.node_id]
          const online = live?.online ?? !n.joins_late
          if (!online && n.joins_late) return (
            <div key={n.node_id} className="rounded-md border border-dashed border-line px-2.5 py-2 text-[10px] font-mono text-dim flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-dim/40" /> {n.operator_name.replace(' (joins late)', '')} — not registered
            </div>
          )
          const cap = n.capability
          return (
            <div key={n.node_id} className={`rounded-md border px-2.5 py-2 bg-white/[0.02] slide-in ${n.joins_late ? 'glow-in border-ok/40' : 'border-line'} ${committed === n.node_id ? 'border-l-2' : ''}`} style={{ borderLeftColor: n.color }}>
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-ok pulse' : 'bg-bad'}`} />
                <span className="text-[12px] font-medium" style={{ color: n.color }}>{n.node_id}</span>
                <span className="text-[10px] text-dim font-mono uppercase tracking-wider">{n.role}</span>
                <span className="flex-1" />
                <span className="text-[10px] text-dim truncate max-w-[120px]">{n.operator_name.replace(' (buyer-side)', '').replace(' (joins late)', '')}</span>
              </div>
              {n.role === 'imaging' ? (
                <div className="text-[10px] font-mono text-dim mt-1">onboard compute: {String(n.onboard?.compute ?? '—')}</div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-1.5 text-[10px] font-mono">
                    <Meter label="CAPACITY" pct={live?.capacity_pct ?? 100} color={n.color} />
                    {cap?.type === 'compute' ? <Meter label="POWER" pct={live?.power_pct ?? 100} color="#fbbf24" /> : <div className="text-dim">max {cap?.max_payload_mb} MB · {cap?.price_per_mb != null ? `$${cap.price_per_mb}/MB` : ''}</div>}
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-[10px] font-mono">
                    <span className="text-dim">QUOTE</span>
                    <span className="num text-ink">{live?.price_usd != null ? `$${live.price_usd.toFixed(2)}` : '—'}</span>
                    <span className="flex-1" />
                    <span className="text-dim">GRANTS</span>
                    <span className="num"><span className="text-accent">{live?.grants.active ?? 0}</span> <span className="text-dim">act</span> <span className="text-ok">{live?.grants.fulfilled ?? 0}</span> <span className="text-dim">ful</span> <span className="text-warn">{live?.grants.revoked ?? 0}</span> <span className="text-dim">rev</span></span>
                  </div>
                  {live?.capacity_label && <div className="text-[9.5px] text-warn font-mono mt-1">{live.capacity_label}</div>}
                  {committed === n.node_id && <div className="text-[9.5px] text-ok font-mono mt-1">▣ holds committed result (preserved across replans)</div>}
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Meter({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between"><span className="text-dim">{label}</span><span className="num">{Math.round(pct)}%</span></div>
      <div className="bar mt-0.5"><div style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  )
}
