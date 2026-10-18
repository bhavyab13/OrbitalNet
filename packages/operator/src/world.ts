import type { Config } from "./config.ts";

/** Sim-time + world public key access. Falls back to local monotonic seconds if the sim is unreachable. */
export function makeWorld(cfg: Config) {
  const boot = Date.now();
  let cache: { t: number; at: number } | null = null;
  let worldPub = cfg.worldPub;
  async function simT(): Promise<number> {
    if (cache && Date.now() - cache.at < 500) return cache.t;
    try {
      const r = await fetch(`${cfg.SIM_URL}/state`, { signal: AbortSignal.timeout(800) });
      const j = (await r.json()) as { sim_t: number };
      cache = { t: Math.floor(Number(j.sim_t)), at: Date.now() };
      return cache.t;
    } catch {
      return Math.floor(((Date.now() - boot) / 1000) * (cfg.scenario.sim?.accel ?? 1));
    }
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
