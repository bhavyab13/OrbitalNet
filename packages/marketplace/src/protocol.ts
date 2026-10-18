/** OCGP §2 helpers: canonical JSON + Ed25519 verification (matches sim/app/crypto.py). */
import * as ed from "@noble/ed25519";

export function canonical(obj: unknown): string {
  const sort = (v: any): any => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(obj));
}
export function b64uDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64"));
}
export function b64uEncode(b: Uint8Array): string {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** Verify `msg.sig` over canonical(msg without sig) with a base64url Ed25519 public key. */
export async function verify(msg: any, publicKeyB64u: string): Promise<boolean> {
  try {
    if (!msg || typeof msg.sig !== "string") return false;
    const { sig, ...body } = msg;
    return await ed.verifyAsync(b64uDecode(sig), new TextEncoder().encode(canonical(body)), b64uDecode(publicKeyB64u));
  } catch {
    return false;
  }
}
export async function sign(msg: any, privateKeyB64u: string, kid: string): Promise<any> {
  const { sig: _s, ...body } = msg;
  body.kid = kid;
  const s = await ed.signAsync(new TextEncoder().encode(canonical(body)), b64uDecode(privateKeyB64u));
  return { ...body, sig: b64uEncode(s) };
}

export type Manifest = {
  ocgp: string; operator_id: string; operator_name: string; node_id: string;
  public_key: string; kid: string; base_url: string;
  capabilities: Array<{ type: "compute" | "relay"; [k: string]: any }>;
  policy?: Record<string, any>; payment?: Record<string, any>; capacity?: Record<string, any>;
  sig: string;
};
export type Quote = {
  quote_id: string; operator_id: string; node_id: string; capability: string; window_id: string;
  window?: { start: number; end: number; bandwidth_mbps?: number };
  units: Record<string, number>; price_usd: number; available_capacity?: Record<string, number>;
  expires_sim_t?: number; kid: string; sig: string;
};
export type Grant = {
  grant_id: string; mission_id: string; operator_id: string; node_id: string; capability: string;
  window_id: string; price_usd: number; payment?: any; kid: string; sig: string; [k: string]: any;
};
export type Leg = {
  kind: "transfer" | "compute"; from?: string | null; to?: string | null; node?: string | null; window_id: string;
  start: number; end: number; bytes_mb: number; duration_s?: number | null; quote_id?: string | null;
  price_usd?: number | null; operator_id?: string | null; node_id?: string | null; capability?: string | null; [k: string]: any;
};
export type Plan = {
  plan_id: string; label: string; legs: Leg[]; delivery_sim_t?: number | null; cost_usd: number;
  feasible: boolean; reasons: string[]; explanation?: string | null;
};
