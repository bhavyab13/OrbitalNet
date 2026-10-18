import { useEffect, useRef, useState } from 'react'
import { proofs } from '../lib/demos'
import type { InstaBoxRow } from '../types'

const host = (u?: string) => { try { return u ? new URL(u).host : '' } catch { return u ?? '' } }
const pill = (state: string) => state.toLowerCase().startsWith('run') ? 'border-ok/60 text-ok' : state.toLowerCase().startsWith('pau') ? 'border-warn/60 text-warn' : 'border-line text-dim'

/** Polls InstaBox for the operator boxes: proof that each satellite operator is a separate machine. */
export default function InstaBoxPanel() {
  const [rows, setRows] = useState<InstaBoxRow[]>([])
  const [meta, setMeta] = useState<{ fetched_at?: string; error?: string; connecting: boolean }>({ connecting: true })
  const [lit, setLit] = useState<Set<string>>(new Set())
  const prev = useRef<Record<string, boolean>>({})
  useEffect(() => {
    let stop = false
    const tick = async () => {
      try {
        const r = await proofs.instabox()
        if (stop) return
        const list = r.boxes ?? []
        const now: Set<string> = new Set()
        for (const b of list) { const on = !!b.operator?.online; if (prev.current[b.name] === false && on) now.add(b.name); prev.current[b.name] = on }
        if (now.size) { setLit(now); setTimeout(() => setLit(new Set()), 6000) }
        setRows(list); setMeta({ fetched_at: r.fetched_at, error: r.error, connecting: false })
      } catch (e: any) { if (!stop) setMeta((m) => ({ ...m, error: m.connecting ? undefined : String(e?.message ?? e), connecting: m.connecting && rows.length === 0 })) }
    }
    tick(); const t = setInterval(tick, 8000)
    return () => { stop = true; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="panel p-3 flex flex-col gap-1.5 shrink-0">
      <div className="panel-title">InstaBox · live</div>
      <div className="flex flex-col gap-1.5 max-h-[118px] 2xl:max-h-[200px] scroll">
      {rows.length === 0 ? (
        <div className="text-[11px] text-dim font-mono">{meta.connecting ? 'connecting to InstaBox…' : (meta.error ?? 'no boxes')}</div>
      ) : rows.map((b) => {
        const on = !!b.operator?.online
        return (
          <div key={b.name} className={`rounded-md border px-2 py-1.5 text-[10px] font-mono transition-colors ${lit.has(b.name) ? 'glow-in border-ok/60' : on ? 'border-line' : 'border-dashed border-line'}`}>
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-ok pulse' : 'bg-dim/40'}`} />
              <span className="text-ink">{b.name}</span>
              <span className={`px-1 rounded border text-[9px] uppercase ${pill(b.state)}`}>{b.state}</span>
              <span className="flex-1" />
              <span className="text-dim truncate max-w-[120px]">{b.node_id ?? ''}{b.role ? ` · ${b.role}` : ''}</span>
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-dim">
              <span className="truncate flex-1">{host(b.public_url) || '—'}</span>
              {on && b.operator ? (
                <span className="whitespace-nowrap">T+{Math.round(b.operator.sim_t ?? 0)}s · {b.operator.grants?.fulfilled ?? 0} fulfilled{b.operator.power_wh != null ? ` · ${b.operator.power_wh} Wh` : ''}{b.operator.rail ? ` · ${b.operator.rail}` : ''}</span>
              ) : (
                <span className="text-warn/80 whitespace-nowrap">idle — waiting for the judge</span>
              )}
            </div>
          </div>
        )
      })}
      </div>
    </div>
  )
}
