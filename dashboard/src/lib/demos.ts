import { MOCK, SIM_URL, postJson } from './sim'
import type { DemoDef, InstaBoxRow, StripePayment } from '../types'

const mockDemos = () => (window as any).__mockDemos
const getJson = async <T,>(path: string): Promise<T> => {
  const r = await fetch(SIM_URL + path)
  if (!r.ok) throw new Error(`${path} ${r.status}`)
  return r.json()
}

/** Stripe `created` may arrive as epoch seconds (Stripe) or an ISO string (sim proxy); normalise to seconds. */
export function toEpochSeconds(v: unknown): number {
  if (typeof v === "number") return v > 1e12 ? v / 1000 : v;
  if (typeof v === "string") { const n = Number(v); if (!Number.isNaN(n)) return n > 1e12 ? n / 1000 : n; const t = Date.parse(v); return Number.isNaN(t) ? 0 : t / 1000; }
  return 0;
}
export const FALLBACK_DEMOS: DemoDef[] = [
  { id: 1, title: 'Impossible alone', subtitle: 'Two strangers, one deadline: conditional commitment, Stripe-paid grants, real inference on an InstaBox satellite', steps: [] },
  { id: 2, title: 'Outage, refund, and a stranger', subtitle: 'The link dies after the work is done: result preserved, grant refunded, a new provider boots and gets paid', steps: [] },
  { id: 3, title: 'Intent changes the deal, and a provider lies', subtitle: 'A cheaper mission picks the low-fidelity crop; reconciliation catches an over-reported attestation', steps: [] },
]

export const demos = {
  list: (): Promise<DemoDef[]> => MOCK ? Promise.resolve(mockDemos()?.list() ?? FALLBACK_DEMOS) : getJson<{ demos: DemoDef[] }>('/demos').then((r) => r.demos ?? FALLBACK_DEMOS),
  start: (id: number) => MOCK ? Promise.resolve(mockDemos()?.start(id)) : postJson(`/demos/${id}/start`, {}),
  stop: () => MOCK ? Promise.resolve(mockDemos()?.stop()) : postJson('/demos/stop', {}),
  status: () => MOCK ? Promise.resolve(mockDemos()?.status()) : getJson<any>('/demos/status'),
}

export const proofs = {
  stripe: (limit = 12): Promise<{ payments: StripePayment[]; account?: string; fetched_at?: string; error?: string }> =>
    MOCK ? Promise.resolve(mockDemos()?.stripe(limit) ?? { payments: [] }) : getJson(`/stripe/payments?limit=${limit}`),
  instabox: (): Promise<{ boxes: InstaBoxRow[]; fetched_at?: string; error?: string }> =>
    MOCK ? Promise.resolve(mockDemos()?.instabox() ?? { boxes: [] }) : getJson('/instabox/boxes'),
}
