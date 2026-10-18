import { useStore } from '../store'

export default function StoryStrip() {
  const storyMode = useStore((s) => s.storyMode)
  const narration = useStore((s) => s.narration)
  const act = useStore((s) => s.currentAct)
  if (!storyMode) return null
  const latest = narration[0]
  return (
    <div className="absolute inset-0 z-20 pointer-events-none letterbox flex flex-col justify-end">
      <div className="mx-auto max-w-[1100px] px-6 pb-[8vh]">
        <div key={latest?.id ?? 'x'} className="panel px-6 py-4 caption border-accent/30">
          <div className="text-[11px] font-mono tracking-[0.3em] text-accent uppercase">{act ?? latest?.act ?? 'OrbitalNet'}</div>
          <div className="text-[20px] leading-snug mt-1 text-ink">{latest?.text ?? 'An open protocol for buying time-windowed capacity on infrastructure you don’t control.'}</div>
          <div className="flex gap-5 mt-3 text-[10px] font-mono text-dim">
            <span><b className="text-ink">▣</b> grant issued</span>
            <span><b className="text-ok">✓</b> attestation</span>
            <span><b className="text-warn">↩</b> refund voucher</span>
            <span><b className="text-bad">⊘</b> rejected</span>
            <span>· physics, policy and payments enforced in code</span>
          </div>
        </div>
      </div>
    </div>
  )
}
