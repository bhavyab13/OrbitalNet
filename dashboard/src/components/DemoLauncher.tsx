import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { demos, FALLBACK_DEMOS } from '../lib/demos'

/** Three demos: each runs the whole protocol flow with judge cues fired at fixed sim times. */
export default function DemoLauncher({ big = false }: { big?: boolean }) {
  const list = useStore((s) => s.demos)
  const demo = useStore((s) => s.demo)
  const setDemos = useStore((s) => s.setDemos)
  const setDemo = useStore((s) => s.setDemo)
  const [busy, setBusy] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (list.length) return
    demos.list().then((d) => setDemos(d.length ? d : FALLBACK_DEMOS)).catch(() => setDemos(FALLBACK_DEMOS))
  }, [list.length, setDemos])
  const items = list.length ? list : FALLBACK_DEMOS

  const start = async (id: number) => {
    if (demo.running) return
    setBusy(id); setErr(null)
    try {
      await demos.start(id)
      // optimistic: the sim confirms with demo_started
      setDemo({ running: true, id, title: items.find((d) => d.id === id)?.title, step: 0, startedAt: Date.now(), done: undefined })
      useStore.getState().setStoryMode(true)
    } catch (e: any) { setErr(String(e?.message ?? e)) }
    finally { setTimeout(() => setBusy(null), 800) }
  }
  const stop = async () => { try { await demos.stop() } catch { /* ignore */ } setDemo({ running: false }) }

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (ev.key === '1' || ev.key === '2' || ev.key === '3') start(Number(ev.key))
      if (ev.key === 'Escape' && useStore.getState().demo.running) stop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, demo.running])

  return (
    <div className={`flex ${big ? 'flex-col' : 'flex-row flex-wrap'} gap-2 items-stretch`}>
      {items.map((d) => {
        const active = demo.running && demo.id === d.id
        return (
          <button key={d.id} disabled={demo.running && !active} title={d.subtitle}
            className={`demo-btn ${big ? 'big' : ''} ${active ? 'running' : ''} ${busy === d.id ? 'busy' : ''}`}
            onClick={() => (active ? stop() : start(d.id))}>
            <span className="n">{d.id}</span>
            <span className="t">
              <span className="title">{d.title}</span>
              {big && d.subtitle && <span className="sub">{d.subtitle}</span>}
            </span>
            {active && <span className="x" aria-label="stop demo">×</span>}
            {active && <span className="dot" />}
          </button>
        )
      })}
      {err && <span className="text-[10px] font-mono text-bad self-center">{err}</span>}
    </div>
  )
}
