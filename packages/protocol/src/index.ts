/**
 * @orbitalnet/protocol — OCGP v0.1 message schemas + Ed25519 signing.
 * See docs/PROTOCOL.md. Canonical JSON: recursively sorted keys, no whitespace.
 * Signature = base64url(Ed25519(canonical_json(message without `sig`, with `kid`))).
 */
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 } from "@noble/hashes/sha256";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// ---------- base64url ----------
export function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
export function unb64u(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

// ---------- canonical JSON ----------
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = canonicalize(v);
    }
    return out;
  }
  return value;
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

// ---------- keys ----------
export type KeyFile = { kid: string; public_key: string; private_key?: string };

export function repoRoot(): string {
  if (process.env.ORBITALNET_ROOT) return process.env.ORBITALNET_ROOT;
  // packages/protocol/src -> repo root
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "data", "scenario.json"))) return dir;
    dir = resolve(dir, "..");
  }
  return process.cwd();
}
export function keysDir(): string {
  return process.env.KEYS_DIR ?? join(repoRoot(), "keys");
}
export function loadKey(kid: string): KeyFile {
  const p = join(keysDir(), `${kid}.json`);
  if (!existsSync(p)) throw new Error(`key file not found: ${p}`);
  return JSON.parse(readFileSync(p, "utf8")) as KeyFile;
}
export function generateKey(kid: string): KeyFile {
  const sk = ed.utils.randomPrivateKey();
  const pk = ed.getPublicKey(sk);
  return { kid, public_key: b64u(pk), private_key: b64u(sk) };
}

// ---------- sign / verify ----------
export type Signed<T> = T & { kid: string; sig: string };

export function sign<T extends Record<string, unknown>>(obj: T, privKeyB64u: string, kid: string): Signed<T> {
  const body = { ...obj, kid } as Record<string, unknown>;
  delete body.sig;
  const msg = new TextEncoder().encode(canonicalJson(body));
  const sig = ed.sign(msg, unb64u(privKeyB64u));
  return { ...(body as T), kid, sig: b64u(sig) };
}
export function verify(obj: Record<string, unknown>, pubKeyB64u: string): boolean {
  try {
    const { sig, ...body } = obj as { sig?: string } & Record<string, unknown>;
    if (typeof sig !== "string" || typeof obj.kid !== "string") return false;
    const msg = new TextEncoder().encode(canonicalJson(body));
    return ed.verify(unb64u(sig), msg, unb64u(pubKeyB64u));
  } catch {
    return false;
  }
}
/** Convenience: sign with a key loaded from keys/<kid>.json. */
export function signAs<T extends Record<string, unknown>>(kid: string, obj: T): Signed<T> {
  const k = loadKey(kid);
  if (!k.private_key) throw new Error(`no private key for ${kid}`);
  return sign(obj, k.private_key, kid);
}

// ---------- ids ----------
export function newId(prefix: string): string {
  const r = ed.utils.randomPrivateKey().slice(0, 8);
  return `${prefix}_${b64u(r)}`;
}
export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return Buffer.from(sha256(bytes)).toString("hex");
}

// ---------- schemas ----------
const Sig = { kid: z.string(), sig: z.string() };

export const WindowSchema = z.object({
  start: z.number(),
  end: z.number(),
  bandwidth_mbps: z.number().optional(),
});

export const ComputeCapabilitySchema = z.object({
  type: z.literal("compute"),
  models: z.array(z.string()),
  max_input_mb: z.number(),
  max_compute_s: z.number(),
  power_budget_wh: z.number(),
  job_power_wh: z.number().optional(),
  modeled_compute_s: z.number().optional(),
  price_base_usd: z.number(),
  price_per_compute_s: z.number(),
  scarcity_alpha: z.number(),
});
export const RelayCapabilitySchema = z.object({
  type: z.literal("relay"),
  max_payload_mb: z.number(),
  price_per_mb: z.number(),
  price_min_usd: z.number(),
  scarcity_alpha: z.number(),
});
export const CapabilitySchema = z.discriminatedUnion("type", [ComputeCapabilitySchema, RelayCapabilitySchema]);

export const ManifestSchema = z.object({
  ocgp: z.literal("0.1"),
  operator_id: z.string(),
  operator_name: z.string(),
  node_id: z.string(),
  public_key: z.string(),
  base_url: z.string(),
  capabilities: z.array(CapabilitySchema),
  policy: z.object({
    allowed_ops: z.array(z.string()),
    deny_arbitrary_code: z.boolean(),
    max_grant_ttl_s: z.number(),
    refund_on_provider_outage: z.boolean(),
  }),
  payment: z.object({
    protocol: z.literal("mpp"),
    methods: z.array(z.string()),
    currency: z.string(),
    recipient: z.string().optional(),
  }),
  capacity: z.record(z.string(), z.number()).optional(),
  ...Sig,
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const QuoteSchema = z.object({
  quote_id: z.string(),
  mission_id: z.string(),
  operator_id: z.string(),
  node_id: z.string(),
  capability: z.enum(["compute", "relay"]),
  window_id: z.string(),
  window: WindowSchema,
  units: z.object({ mb: z.number().optional(), compute_s: z.number().optional() }),
  price_usd: z.number(),
  available_capacity: z.record(z.string(), z.number()),
  expires_sim_t: z.number(),
  ...Sig,
});
export type Quote = z.infer<typeof QuoteSchema>;

export const HoldSchema = z.object({
  hold_id: z.string(),
  quote_id: z.string(),
  expires_sim_t: z.number(),
});
export type Hold = z.infer<typeof HoldSchema>;

export const ReceiptSchema = z
  .object({
    method: z.string(),
    reference: z.string(),
    status: z.string(),
    timestamp: z.string(),
  })
  .passthrough();

export const GrantSchema = z.object({
  grant_id: z.string(),
  mission_id: z.string(),
  operator_id: z.string(),
  node_id: z.string(),
  capability: z.enum(["compute", "relay"]),
  op: z.string(),
  model: z.string().optional(),
  window_id: z.string(),
  window: WindowSchema,
  limits: z.object({
    max_input_mb: z.number().optional(),
    max_compute_s: z.number().optional(),
    max_output_mb: z.number().optional(),
    max_payload_mb: z.number().optional(),
  }),
  valid_sim_t: z.object({ not_before: z.number(), not_after: z.number() }),
  price_usd: z.number(),
  payment: z.object({
    protocol: z.literal("mpp"),
    method: z.string(),
    receipt_ref: z.string(),
    receipt: ReceiptSchema,
  }),
  holder: z.string(),
  quote_id: z.string().optional(),
  issued_at: z.string(),
  ...Sig,
});
export type Grant = z.infer<typeof GrantSchema>;

export const WorldAssertionSchema = z.object({
  sim_t: z.number(),
  window_id: z.string().optional(),
  open: z.boolean().optional(),
  link: z.array(z.string()).nullish(),
  bandwidth_mbps: z.number().nullish(),
  window: z.object({ start: z.number(), end: z.number() }).nullish(),
  issued_at: z.string(),
  ...Sig,
}).passthrough(); // never strip fields: the signature covers the whole object
export type WorldAssertion = z.infer<typeof WorldAssertionSchema>;

export const AttestationSchema = z.object({
  attestation_id: z.string(),
  grant_id: z.string(),
  mission_id: z.string(),
  node_id: z.string(),
  operator_id: z.string(),
  op: z.string(),
  input_bytes: z.number(),
  output_bytes: z.number(),
  compute_s: z.number(),
  power_wh: z.number(),
  result_sha256: z.string(),
  sim_t_start: z.number(),
  sim_t_end: z.number(),
  receipt_ref: z.string().optional(),
  ...Sig,
});
export type Attestation = z.infer<typeof AttestationSchema>;

export const RefundVoucherSchema = z.object({
  voucher_id: z.string(),
  grant_id: z.string(),
  mission_id: z.string(),
  operator_id: z.string(),
  amount_usd: z.number(),
  reason: z.string(),
  receipt_ref: z.string(),
  issued_at: z.string(),
  ...Sig,
});
export type RefundVoucher = z.infer<typeof RefundVoucherSchema>;

export const GrantRejectReason = z.enum([
  "window_closed",
  "bad_signature",
  "revoked",
  "already_used",
  "expired",
  "payload_too_large",
  "op_not_allowed",
  "bad_world_assertion",
  "wrong_node",
]);
export type GrantRejectReason = z.infer<typeof GrantRejectReason>;
