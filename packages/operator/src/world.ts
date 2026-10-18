import type { Config } from "./config.ts";

/** Sim-time + world public key access. Falls back to local monotonic seconds if the sim is unreachable. */
export function makeWorld(cfg: Config) {
  const boot = Date.now();
  let cache: { t: number; at: number } | null = null;
  let worldPub = cfg.worldPub;
  const accel = cfg.scenario.sim?.accel ?? 1;
  async function simT(): Promise<number> {
    if (cache && Date.now() - cache.at < 500) return cache.t;
    // Remote operators (InstaBox) reach the world over a tunnel: allow a slow round trip, and if it
    // fails, extrapolate from the last known world time instead of inventing a clock of our own.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`${cfg.SIM_URL}/state`, { signal: AbortSignal.timeout(attempt === 0 ? 4000 : 6000) });
        const j = (await r.json()) as { sim_t: number };
        cache = { t: Math.floor(Number(j.sim_t)), at: Date.now() };
        return cache.t;
      } catch { /* retry once */ }
    }
    if (cache) return Math.floor(cache.t + ((Date.now() - cache.at) / 1000) * accel);
    return Math.floor(((Date.now() - boot) / 1000) * accel);
  }
  async function fetchWorldPub(): Promise<string> {
    if (worldPub) return worldPub;
    try {
      const r = await fetch(`${cfg.SIM_URL}/keys`, { signal: AbortSignal.timeout(1500) });
      const j: any = await r.json();
      const list: any[] = Array.isArray(j) ? j : Array.isArray(j.keys) ? j.keys : [j];
      const w = list.find((k) => k.kid === "world") ?? list[0];
      if (w?.public_key) worldPub = w.public_key;
    } catch {
      /* retry later */
    }
    return worldPub;
  }
  return { simT, fetchWorldPub, get worldPub() { return worldPub; } };
}
export type World = ReturnType<typeof makeWorld>;
