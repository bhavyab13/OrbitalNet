import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { fmtT } from './MissionHUD'

/** Bottom strip while a scripted demo runs: step counter, title, detail, segmented progress; summary for 10 s at the end. */
export default function DemoStrip() {
  const demo = useStore((s) => s.demo)
  const [showDone, setShowDone] = useState(false)
  useEffect(() => {
    if (!demo.done) { setShowDone(false); return }
    setShowDone(true)
    const t = setTimeout(() => setShowDone(false), 10000)
    return () => clearTimeout(t)
  }, [demo.done])
  if (!demo.running && !showDone) return null
  const total = demo.total ?? 0
  const step = demo.step ?? 0
  const sum = demo.done?.summary
  return (
    <div className="absolute left-0 right-0 bottom-0 z-20 pointer-events-none">
      <div className="mx-auto max-w-[1100px] px-6 pb-6">
        <div key={`${demo.id}-${step}-${showDone ? 'd' : 'r'}`} className={`panel px-6 py-4 caption ${showDone ? (demo.done?.status === 'DELIVERED' ? 'border-ok/50' : 'border-warn/50') : 'border-accent/30'}`}>
          {showDone && demo.done ? (
            <>
              <div className="text-[11px] font-mono tracking-[0.3em] text-ok uppercase">Demo {demo.id} · {demo.done.status}</div>
              <div className="text-[20px] leading-snug mt-1 text-ink">
                {sum?.delivered_sim_t != null ? `Delivered at T+${Math.round(sum.delivered_sim_t)}s` : demo.done.status}
                {sum?.total_paid_usd != null ? ` · paid $${Number(sum.total_paid_usd).toFixed(2)}` : ''}
                {sum?.fidelity ? ` · ${sum.fidelity} fidelity` : ''}
                {sum?.reconcile_ok != null ? ` · reconcile ${sum.reconcile_ok ? '✓' : '⚠'}` : ''}
              </div>
              {sum?.reconcile_summary && <div className="text-[11px] font-mono text-dim mt-1">{sum.reconcile_summary}</div>}
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 text-[11px] font-mono tracking-[0.3em] text-accent uppercase">
                <span>Demo {demo.id}</span>
                {total > 0 && <span className="text-dim">step {step}/{total}</span>}
                <span className="flex-1" />
                <span className="text-dim tracking-normal normal-case">{demo.title}</span>
              </div>
              <div className="text-[20px] leading-snug mt-1 text-ink">{demo.stepTitle ?? demo.subtitle ?? 'Starting…'}</div>
              {demo.stepDetail && <div className="text-[12px] text-dim mt-1 leading-snug">{demo.stepDetail}</div>}
              {total > 0 && (
                <div className="flex gap-1 mt-3">
                  {Array.from({ length: total }, (_, i) => <span key={i} className={`h-1 flex-1 rounded-sm ${i < step ? 'bg-accent' : i === step ? 'bg-accent/50 pulse' : 'bg-line'}`} />)}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
export { fmtT }
