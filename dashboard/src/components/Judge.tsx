import { useState } from 'react'
import { useStore } from '../store'
import { clock, disrupt } from '../lib/controls'
import { fmtT } from './MissionHUD'
import DemoLauncher from './DemoLauncher'

const typeIcon: Record<string, string> = { kill_link: '⚡', competing_reserve: '⚔', launch_provider: '🛰', revoke: '⊗', restore_link: '↻' }

export default function Judge() {
  const { scenario, simT, status, paused, accel, spentUsd, windows, nodes } = useStore()
  const [busy, setBusy] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  if (!scenario) return null
  const fire = async (d: any) => {
    setBusy(d.id)
    try { await disrupt({ ...d, type: d.type }); setLog((l) => [`${fmtT(simT)} ${d.label}`, ...l].slice(0, 8)) }
    catch (e: any) { setLog((l) => [`${fmtT(simT)} FAILED ${d.label}: ${e?.message ?? e}`, ...l]) }
    finally { setTimeout(() => setBusy(null), 600) }
  }
  const killed = Object.values(windows).filter((w) => w.status === 'killed')
  return (
    <div className="h-full scroll px-4 py-4 max-w-[560px] mx-auto flex flex-col gap-3">
      <div className="panel p-3 flex flex-col gap-2">
        <div className="panel-title">Demos</div>
        <DemoLauncher big />
      </div>
      <div className="panel p-3">
        <div className="panel-title">Judge console</div>
        <div className="grid grid-cols-3 gap-2 mt-2">
          <div><div className="text-[9px] font-mono text-dim">CLOCK</div><div className="num text-[22px]">{fmtT(simT)}</div></div>
          <div><div className="text-[9px] font-mono text-dim">STATUS</div><div className={`num text-[10px] mt-2 leading-tight break-all ${status === 'REPLAN_REQUIRED' ? 'text-warn' : status === 'DELIVERED' ? 'text-ok' : status === 'INFEASIBLE' ? 'text-bad' : 'text-ink'}`}>{status}</div></div>
          <div><div className="text-[9px] font-mono text-dim">SPENT</div><div className="num text-[20px] text-ok">${spentUsd.toFixed(2)}</div></div>
        </div>
        <div className="flex gap-1 mt-3 flex-wrap">
          <button className="btn" onClick={() => (paused ? clock.resume() : clock.pause())}>{paused ? '▶ resume' : '❚❚ pause'}</button>
          {[1, 4, 10].map((a) => <button key={a} className={`btn ${accel === a ? 'active' : ''}`} onClick={() => clock.setAccel(a)}>{a}×</button>)}
          <button className="btn" onClick={() => clock.reset()}>↺ reset</button>
        </div>
      </div>

      <div className="panel p-3 flex flex-col gap-2">
        <div className="panel-title">Break the mission</div>
        {scenario.disruptions.map((d) => {
          const w = d.window_id ? windows[d.window_id] : undefined
          const n = d.node_id ? nodes[d.node_id] : undefined
          const hint = d.type === 'kill_link' && w ? `${w.from} → ${w.to} · T+${w.start}–${w.end}s · now ${w.status}` : d.type === 'launch_provider' ? (n?.online ? 'already online' : 'offline — tap to boot from snapshot') : d.node_id ? `${d.node_id}${d.fraction ? ` · takes ${Math.round(d.fraction * 100)}%` : ''}` : ''
          return (
            <button key={d.id} disabled={busy === d.id} className={`btn big ${d.type === 'launch_provider' ? '' : 'danger'} ${busy === d.id ? 'active' : ''}`} onClick={() => fire(d)}>
              <div className="flex items-center gap-3">
                <span className="text-[22px] leading-none">{typeIcon[d.type] ?? '•'}</span>
                <div className="min-w-0">
                  <div className="normal-case tracking-normal text-[14px] text-ink">{d.label}</div>
                  <div className="text-[10px] text-dim normal-case tracking-normal mt-0.5">{hint}{d.suggested_sim_t ? ` · best at ${fmtT(d.suggested_sim_t)}` : ''}</div>
                </div>
              </div>
            </button>
          )
        })}
        {killed.length > 0 && killed.map((w) => (
          <button key={w.window_id} className="btn big" onClick={() => fire({ id: 'restore-' + w.window_id, label: `Restore ${w.window_id}`, type: 'restore_link', window_id: w.window_id })}>
            <div className="flex items-center gap-3"><span className="text-[22px]">↻</span><div className="normal-case tracking-normal text-[14px]">Restore link {w.window_id}</div></div>
          </button>
        ))}
      </div>

      <div className="panel p-3">
        <div className="panel-title">Sent</div>
        <div className="flex flex-col gap-1 mt-1 text-[11px] font-mono text-dim">{log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <div>—</div>}</div>
      </div>
    </div>
  )
}
