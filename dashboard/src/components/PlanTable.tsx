import { useStore } from '../store'
import { fmtT } from './MissionHUD'

export default function PlanTable() {
  const plans = useStore((s) => s.plans)
  const deadline = useStore((s) => s.scenario?.mission.deadline_sim_t ?? 0)
  return (
    <div className="panel p-3 flex flex-col gap-2 min-h-[120px]">
      <div className="panel-title">Plan candidates · time-expanded search</div>
      {plans.length === 0 ? (
        <div className="text-[11px] text-dim font-mono">awaiting plan_mission…</div>
      ) : (
        <table className="w-full text-[11px]">
          <thead className="text-[9px] font-mono text-dim tracking-widest">
            <tr><th className="text-left font-normal pb-1">PATH</th><th className="text-right font-normal pb-1 px-2">DELIVERY</th><th className="text-right font-normal pb-1 px-2">COST</th><th className="text-right font-normal pb-1 pr-1 w-6">OK</th></tr>
          </thead>
          <tbody>
            {plans.map((p) => {
              const late = p.delivery_sim_t != null && p.delivery_sim_t > deadline
              return (
                <tr key={p.plan_id} title={(p.reasons ?? []).join('\n')} className={`${p.chosen ? 'bg-accent/10 outline outline-1 outline-accent/40' : ''} ${!p.feasible ? 'opacity-60' : ''} slide-in`}>
                  <td className="py-1 pl-1 pr-2 leading-tight">
                    <div className="flex items-center gap-1.5">
                      {p.chosen && <span className="w-1.5 h-1.5 rounded-full bg-accent pulse" />}
                      <span className={p.chosen ? 'text-ink' : 'text-ink/85'}>{p.label}</span>
                    </div>
                    {!p.feasible && p.reasons?.[0] && <div className="text-[9.5px] text-bad/80 font-mono mt-0.5">{p.reasons[0]}</div>}
                  </td>
                  <td className={`num text-right whitespace-nowrap px-2 ${late ? 'text-bad' : 'text-ink'}`}>{p.delivery_sim_t == null ? '—' : fmtT(p.delivery_sim_t)}</td>
                  <td className="num text-right whitespace-nowrap px-2">{p.cost_usd == null ? '—' : `$${p.cost_usd.toFixed(2)}`}</td>
                  <td className="text-right pr-1">{p.feasible ? <span className="text-ok">✓</span> : <span className="text-bad">✗</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
