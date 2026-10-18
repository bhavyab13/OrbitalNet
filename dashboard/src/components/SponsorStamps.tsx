import { useEffect, useState } from 'react'
import { useFx, fxNow, type Sponsor } from '../fx'

const ORDER: Sponsor[] = ['Stripe', 'Manufact', 'InstaBox']
const ROLE: Record<Sponsor, string> = { Stripe: 'machine payments', Manufact: 'MCP cloud', InstaBox: 'operator machines' }

/** Chips that light up for ~4 s whenever a sponsor product does real work; dim persistent counters otherwise. */
export default function SponsorStamps() {
  const pings = useFx((s) => s.pings)
  const counts = useFx((s) => s.counts)
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 500); return () => clearInterval(t) }, [])
  const now = fxNow()
  return (
    <div className="flex flex-col items-end gap-1 pointer-events-none">
      <div className="flex gap-1.5">
        {ORDER.map((sp) => {
          const latest = pings.find((p) => p.sponsor === sp)
          const hot = latest && now - latest.at < 4000
          return (
            <div key={sp} className={`panel px-2.5 py-1 font-mono text-[10px] tracking-wider whitespace-nowrap transition-all duration-500 ${hot ? 'border-accent/60 text-ink shadow-[0_0_24px_rgba(79,209,255,0.25)]' : 'text-dim/80'}`}>
              <span className={hot ? 'text-accent' : ''}>{sp.toUpperCase()}</span>
              <span className="text-dim/70 hidden 2xl:inline"> · {ROLE[sp]}</span>
              <span className={`ml-2 num ${counts[sp] ? 'text-ink/80' : 'text-dim/50'}`}>{counts[sp]}</span>
            </div>
          )
        })}
      </div>
      {pings.slice(0, 1).map((p) => (now - p.at < 4000 ? (
        <div key={p.id} className="panel px-3 py-1.5 font-mono text-[11px] text-ink border-accent/40 slide-in max-w-[520px] truncate">
          <span className="text-accent">{p.sponsor}</span> · {p.text}
        </div>
      ) : null))}
    </div>
  )
}
