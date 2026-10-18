import type { Config } from "./config.ts";

/** Fire-and-forget event push to the World (sim). Never throws. */
export function makeEmitter(cfg: Config) {
  return async function emit(type: string, data: Record<string, unknown> = {}) {
    const body = { type, node_id: cfg.NODE_ID, operator_id: cfg.OPERATOR_ID, ts: new Date().toISOString(), ...data };
    try {
      await fetch(`${cfg.SIM_URL}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(1500),
      });
    } catch {
      /* sim offline — non-fatal */
    }
    console.log(`[${cfg.NODE_ID}] event ${type}`, JSON.stringify(data).slice(0, 160));
  };
}
export type Emit = ReturnType<typeof makeEmitter>;
