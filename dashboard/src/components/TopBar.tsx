import { useStore } from '../store'
import { clock } from '../lib/controls'
import { Link, useLocation } from 'react-router-dom'

const statusColor: Record<string, string> = {
  IDLE: 'text-dim border-line', PLANNED: 'text-accent border-accent/50', RUNNING: 'text-ok border-ok/50',
  REPLAN_REQUIRED: 'text-warn border-warn/60', DELIVERED: 'text-ok border-ok', INFEASIBLE: 'text-bad border-bad', FAILED: 'text-bad border-bad',
}

export default function TopBar() {
  const { scenario, mode, connected, status, paused, accel, storyMode, setStoryMode } = useStore()
  const loc = useLocation()
  return (
    <div className="h-12 flex items-center gap-3 px-3 sm:px-4 border-b border-line bg-[rgba(5,8,15,0.8)] backdrop-blur-md relative z-20 overflow-hidden">
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-full border-2 border-accent relative">
          <div className="absolute inset-[5px] rounded-full bg-accent/80" />
          <div className="absolute -top-[3px] left-1/2 w-[3px] h-[3px] rounded-full bg-white" />
        </div>
        <div className="font-mono tracking-[0.25em] text-sm font-semibold">ORBITALNET</div>
        <div className="font-mono text-[10px] text-dim tracking-widest hidden md:block">MISSION CONTROL</div>
      </div>
      <div className="h-5 w-px bg-line hidden lg:block" />
      <div className="font-mono text-[11px] text-dim truncate max-w-[340px] hidden lg:block">{scenario?.scenario_id ?? '—'}</div>
      <div className={`font-mono text-[10px] px-2 py-0.5 rounded border whitespace-nowrap hidden sm:block ${mode === 'mock' ? 'border-warn/50 text-warn' : 'border-ok/50 text-ok'}`}>
        {mode === 'mock' ? 'MOCK REPLAY' : connected ? 'LIVE' : 'LIVE · RECONNECTING'}
      </div>
      <div className={`font-mono text-[10px] px-2.5 py-0.5 rounded-full border whitespace-nowrap ${statusColor[status] ?? 'text-dim border-line'} flex items-center gap-2`}>
        <span className={`w-1.5 h-1.5 rounded-full bg-current ${status === 'RUNNING' ? 'pulse' : ''}`} />
        {status}
      </div>
      <div className="flex-1" />
      <div className="hidden md:flex items-center gap-1">
        <button className="btn" onClick={() => (paused ? clock.resume() : clock.pause())}>{paused ? '▶ resume' : '❚❚ pause'}</button>
        {[1, 4, 10].map((a) => (
          <button key={a} className={`btn ${accel === a ? 'active' : ''}`} onClick={() => clock.setAccel(a)}>{a}×</button>
        ))}
        <button className="btn" onClick={() => clock.reset()}>↺</button>
      </div>
      <div className="h-5 w-px bg-line hidden md:block" />
      <button className={`btn hidden md:inline-block ${storyMode ? 'active' : ''}`} onClick={() => setStoryMode(!storyMode)}>Story mode</button>
      <Link to={loc.pathname === '/judge' ? '/' : '/judge'} className="btn">{loc.pathname === '/judge' ? 'Control room' : 'Judge panel'}</Link>
    </div>
  )
}
