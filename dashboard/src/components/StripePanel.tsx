import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { proofs, toEpochSeconds } from '../lib/demos'
import type { StripePayment } from '../types'

const rel = (sec: number) => { const d = Math.max(0, Math.floor(Date.now() / 1000 - sec)); return d < 60 ? `${d}s ago` : d < 3600 ? `${Math.floor(d / 60)}m ago` : `${Math.floor(d / 3600)}h ago` }

/** Pulls PaymentIntents straight from the Stripe sandbox (via the sim proxy) every 3 s — the proof the money is real. */
export default function StripePanel() {
  const [rows, setRows] = useState<StripePayment[]>([])
  const [meta, setMeta] = useState<{ account?: string; fetched_at?: string; error?: string; connecting: boolean }>({ connecting: true })
  const [flash, setFlash] = useState<Set<string>>(new Set())
  const seen = useRef<Set<string>>(new Set())
  const first = useRef(true)
  const startedAt = useStore((s) => s.demo.startedAt)
  useEffect(() => {
    let stop = false
    const tick = async () => {
      try {
        const r = await proofs.stripe(12)
        if (stop) return
        const list = r.payments ?? []
        const fresh = list.filter((p) => !seen.current.has(p.id)).map((p) => p.id)
        if (!first.current && fresh.length) { setFlash(new Set(fresh)); setTimeout(() => setFlash(new Set()), 2500) }
        for (const p of list) seen.current.add(p.id)
        first.current = false
        setRows(list)
        setMeta({ account: r.account, fetched_at: r.fetched_at, error: r.error, connecting: false })
      } catch (e: any) { if (!stop) setMeta((m) => ({ ...m, error: m.connecting ? undefined : String(e?.message ?? e), connecting: m.connecting && seen.current.size === 0 })) }
    }
    tick(); const t = setInterval(tick, 3000)
    return () => { stop = true; clearInterval(t) }
  }, [])
  const sinceStart = startedAt ? rows.filter((p) => toEpochSeconds(p.created) * 1000 >= startedAt - 5000) : rows
  const total = sinceStart.reduce((a, p) => a + p.amount_cents, 0) / 100
  return (
    <div className="panel p-3 flex flex-col gap-2">
      <div className="panel-title">Stripe sandbox · live</div>
      <div className="flex items-center gap-2 text-[10px] font-mono text-dim">
        <span className="truncate">{meta.account ?? (meta.connecting ? 'connecting…' : 'sandbox')}</span>
        <span className="flex-1" />
        {meta.fetched_at && <span>fetched {rel(new Date(meta.fetched_at).getTime() / 1000)}</span>}
      </div>
      {rows.length > 0 && (
        <div className="text-[11px] font-mono"><span className="text-ink">{sinceStart.length}</span> <span className="text-dim">PaymentIntents ·</span> <span className="text-ok num">${total.toFixed(2)}</span> <span className="text-dim">{startedAt ? 'this run' : 'recent'}</span></div>
      )}
      {meta.error && <div className="text-[10px] font-mono text-dim/70 truncate">{meta.error}</div>}
      {rows.length === 0 ? (
        <div className="text-[11px] text-dim font-mono">{meta.connecting ? 'connecting to Stripe…' : 'no PaymentIntents yet'}</div>
      ) : (
        <div className="flex flex-col gap-1 max-h-[132px] scroll">
          {rows.slice(0, 12).map((p) => (
            <div key={p.id} className={`flex items-center gap-2 text-[11px] rounded px-1 -mx-1 ${flash.has(p.id) ? 'slide-in stripe-flash' : ''}`}>
              <span className="num text-ink w-[46px] text-right">${(p.amount_cents / 100).toFixed(2)}</span>
              <span className={`font-mono text-[9px] px-1 rounded border uppercase ${p.intent === 'session' ? 'border-accent/60 text-accent' : 'border-line text-dim'}`}>{p.intent === 'session' ? 'session' : p.intent === 'charge' ? 'charge' : 'pi'}</span>
              <span className={`font-mono text-[9px] ${p.status === 'succeeded' ? 'text-ok' : p.status === 'processing' ? 'text-warn' : 'text-dim'}`}>{p.status}</span>
              <span className="flex-1" />
              <span className="num text-[10px] text-dim">{rel(toEpochSeconds(p.created))}</span>
              {p.url ? <a className="num text-[10px] text-accent/80 hover:text-accent" href={p.url} target="_blank" rel="noreferrer">{p.id.slice(0, 11)}…</a> : <span className="num text-[10px] text-dim">{p.id.slice(0, 11)}…</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
