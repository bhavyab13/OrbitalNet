import { useStore } from '../store'

export const fmtT = (t: number) => {
  const s = Math.max(0, Math.floor(t))
  const m = Math.floor(s / 60)
  return `T+${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export default function MissionHUD() {
  const { scenario, simT, status, spentUsd, refundedUsd, accel, paused } = useStore()
  if (!scenario) return null
  const m = scenario.mission
  const remaining = m.deadline_sim_t - simT
  const pctT = Math.min(100, Math.max(0, (100 * simT) / m.deadline_sim_t))
  const tColor = status === 'DELIVERED' ? 'text-ok' : remaining < 0 ? 'text-bad' : remaining < 120 ? 'text-warn' : 'text-ink'
  const pctB = Math.min(100, (100 * spentUsd) / m.budget_usd)
  const epoch = new Date(new Date(scenario.epoch_utc).getTime() + simT * 1000)

  return (
    <div className="panel p-3 flex flex-col gap-3">
      <div className="panel-title">Mission · {m.mission_id}</div>
      <div className="text-[12px] leading-snug text-ink/90 italic">“{m.text}”</div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] font-mono text-dim tracking-widest">SIM CLOCK {paused ? '· PAUSED' : `· ${accel}×`}</div>
          <div className="num text-[30px] leading-none mt-1">{fmtT(simT)}</div>
          <div className="num text-[10px] text-dim mt-1">{epoch.toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
        </div>
        <div>
          <div className="text-[10px] font-mono text-dim tracking-widest">DEADLINE {fmtT(m.deadline_sim_t)}</div>
          <div className={`num text-[30px] leading-none mt-1 ${tColor}`}>{remaining >= 0 ? '−' : '+'}{fmtT(Math.abs(remaining)).slice(2)}</div>
          <div className="bar mt-2"><div style={{ width: `${pctT}%`, background: remaining < 120 ? 'var(--color-warn)' : 'var(--color-accent)' }} /></div>
        </div>
      </div>
      <div>
        <div className="flex justify-between text-[10px] font-mono text-dim tracking-widest">
          <span>BUDGET</span>
          <span className="text-ink">${spentUsd.toFixed(2)} <span className="text-dim">/ ${m.budget_usd.toFixed(2)}</span>{refundedUsd > 0 && <span className="text-warn"> · refunded ${refundedUsd.toFixed(2)}</span>}</span>
        </div>
        <div className="bar mt-1"><div style={{ width: `${pctB}%`, background: pctB > 90 ? 'var(--color-warn)' : 'var(--color-ok)' }} /></div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
        <Stat label="PAYLOAD" value={`${m.payload_mb} MB`} />
        <Stat label="SOURCE" value={m.source_node} />
        <Stat label="RESULT" value={`~${Math.round(m.result_mb_estimate * 1000)} KB`} />
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line px-2 py-1.5 bg-white/[0.02]">
      <div className="text-dim tracking-widest text-[9px]">{label}</div>
      <div className="num text-[11px] mt-0.5 truncate">{value}</div>
    </div>
  )
}
