import { GrantSchema, WorldAssertionSchema, verify, type Grant, type WorldAssertion, type GrantRejectReason } from "@orbitalnet/protocol";
import type { OperatorState } from "./state.ts";

export type Rejection = { reason: GrantRejectReason; detail?: string };

/**
 * Offline grant verification (PROTOCOL §2.6). The node trusts only its own signature and the World key.
 */
export function verifyFulfilment(
  st: OperatorState,
  worldPub: string,
  input: { grant: unknown; world_assertion: unknown; payload_bytes: number; op?: string },
): { ok: true; grant: Grant; wa: WorldAssertion } | { ok: false; rej: Rejection } {
  const gp = GrantSchema.safeParse(input.grant);
  if (!gp.success) return { ok: false, rej: { reason: "bad_signature", detail: "grant does not parse: " + gp.error.issues[0]?.message } };
  const grant = gp.data;
  if (grant.node_id !== st.cfg.NODE_ID || grant.operator_id !== st.cfg.OPERATOR_ID)
    return { ok: false, rej: { reason: "wrong_node", detail: `grant is for ${grant.node_id}/${grant.operator_id}` } };
  if (!verify(input.grant as any, st.cfg.key.public_key)) return { ok: false, rej: { reason: "bad_signature" } };
  const rec = st.grants.get(grant.grant_id);
  if (!rec) return { ok: false, rej: { reason: "bad_signature", detail: "grant unknown to this node" } };
  if (rec.status === "revoked") return { ok: false, rej: { reason: "revoked" } };
  if (rec.status === "fulfilled") return { ok: false, rej: { reason: "already_used" } };

  const wp = WorldAssertionSchema.safeParse(input.world_assertion);
  if (!wp.success) return { ok: false, rej: { reason: "bad_world_assertion", detail: "assertion does not parse" } };
  const wa = wp.data;
  if (!worldPub || !verify(input.world_assertion as any, worldPub)) return { ok: false, rej: { reason: "bad_world_assertion", detail: "signature" } };
  if (wa.window_id !== grant.window_id) return { ok: false, rej: { reason: "window_closed", detail: `assertion is for ${wa.window_id}, grant for ${grant.window_id}` } };
  if (wa.open !== true) return { ok: false, rej: { reason: "window_closed" } };
  if (wa.sim_t > grant.valid_sim_t.not_after) return { ok: false, rej: { reason: "expired", detail: `sim_t ${wa.sim_t} > not_after ${grant.valid_sim_t.not_after}` } };
  if (wa.sim_t < grant.valid_sim_t.not_before) return { ok: false, rej: { reason: "expired", detail: "not yet valid" } };
  if (wa.sim_t < grant.window.start || wa.sim_t > grant.window.end) return { ok: false, rej: { reason: "window_closed", detail: `sim_t ${wa.sim_t} outside [${grant.window.start},${grant.window.end}]` } };

  const op = input.op ?? grant.op;
  const allowed: string[] = (st.cfg.node as any).policy?.allowed_ops ?? (st.role === "compute" ? ["image-inference"] : ["relay"]);
  if (op !== grant.op || !allowed.includes(op)) return { ok: false, rej: { reason: "op_not_allowed", detail: op } };
  if (grant.capability === "compute" && grant.model && !(st.cap.models ?? []).includes(grant.model))
    return { ok: false, rej: { reason: "op_not_allowed", detail: `model ${grant.model}` } };

  const limitMb = grant.capability === "compute" ? grant.limits.max_input_mb : grant.limits.max_payload_mb;
  // Grants are quoted on the modeled payload; allow 10% + 8 KB of framing/envelope overhead (OCGP §2.6).
  const allowedBytes = limitMb !== undefined ? limitMb * 1e6 * 1.1 + 8192 : undefined;
  if (allowedBytes !== undefined && input.payload_bytes > allowedBytes)
    return { ok: false, rej: { reason: "payload_too_large", detail: `${(input.payload_bytes / 1e6).toFixed(3)} MB > ${limitMb} MB (+10% framing)` } };
  return { ok: true, grant, wa };
}
