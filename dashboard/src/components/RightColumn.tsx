import { useMemo } from 'react'
import { useStore } from '../store'
import { EXPLORER_TX_URL } from '../lib/sim'
import { fmtT } from './MissionHUD'

export function Narration() {
  const narration = useStore((s) => s.narration)
  const act = useStore((s) => s.currentAct)
  const latest = narration[0]
  return (
    <div className="panel p-3 flex flex-col gap-2">
      <div className="panel-title">Buyer agent · narration</div>
      {latest ? (
        <>
          <div className="text-[10px] font-mono text-accent tracking-widest uppercase">{act ?? latest.act ?? ''}</div>
          <div key={latest.id} className="text-[13px] leading-snug text-ink caption">{latest.text}</div>
          <div className="flex flex-col gap-1 mt-1 max-h-[80px] overflow-hidden" style={{ maskImage: "linear-gradient(#000 60%, transparent)" }}>
            {narration.slice(1, 4).map((n) => (
              <div key={n.id} className="text-[10px] leading-tight text-dim"><span className="num text-dim/70">{fmtT(n.sim_t)}</span> · {n.text}</div>
            ))}
          </div>
        </>
      ) : (
        <div className="text-[11px] text-dim font-mono">waiting for mission…</div>
      )}
    </div>
  )
}

export function PaymentTicker() {
  const payments = useStore((s) => s.payments)
  const scenario = useStore((s) => s.scenario)
  const nodeMeta = useMemo(() => Object.fromEntries((scenario?.nodes ?? []).map((n) => [n.operator_id, n])), [scenario])
  return (
    <div className="panel p-3 flex flex-col gap-2">
      <div className="panel-title">Machine payments · MPP</div>
      {payments.length === 0 ? (
        <div className="text-[11px] text-dim font-mono">no payments yet</div>
      ) : (
        <div className="flex flex-col gap-1.5 max-h-[150px] scroll">
          {payments.map((p) => {
            const n = nodeMeta[p.operator_id]
            const href = p.method === 'tempo' && p.receipt_ref?.startsWith('0x') ? EXPLORER_TX_URL + p.receipt_ref : undefined
            return (
              <div key={p.id} className="flex items-center gap-2 text-[11px] slide-in">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: n?.color ?? '#9ad' }} />
                <span className="num text-dim text-[10px]">{fmtT(p.sim_t)}</span>
                <span className="truncate" style={{ color: n?.color }}>{n?.operator_name?.replace(/ \(.*\)/, '') ?? p.operator_id}</span>
                <span className="flex-1" />
                <span className="font-mono text-[9px] px-1 rounded border border-line text-dim uppercase">{p.method}</span>
                {href ? <a className="num text-[10px] text-accent/80 hover:text-accent" href={href} target="_blank" rel="noreferrer">{p.receipt_ref.slice(0, 8)}…</a> : <span className="num text-[10px] text-dim">{p.receipt_ref.slice(0, 10)}</span>}
                <span className="num text-ok">${p.amount_usd.toFixed(2)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const sev: Record<string, string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', info: 'text-ink/85' }
const icon: Record<string, string> = { grant_issued: '▣', grant_rejected: '⊘', refund: '↩', attestation: '✓', info: '·', hold: '◌', revoked: '⊗' }

export function AuditFeed() {
  const audit = useStore((s) => s.audit)
  return (
    <div className="panel p-3 flex flex-col gap-2 flex-1 min-h-0">
      <div className="panel-title">Audit · grants · attestations</div>
      <div className="flex flex-col gap-1 scroll min-h-0">
        {audit.length === 0 && <div className="text-[11px] text-dim font-mono">—</div>}
        {audit.map((a) => (
          <div key={a.id} className="text-[10.5px] leading-tight slide-in">
            <span className="num text-dim/70">{fmtT(a.sim_t)}</span> <span className={`${sev[a.severity]} font-mono`}>{icon[a.kind] ?? '·'}</span> <span className={a.severity === 'bad' ? 'text-bad' : 'text-ink/90'}>{a.text}</span>
            {a.detail && <div className="text-[9.5px] text-dim font-mono pl-[52px]">{a.detail}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
