/** Broker wallet: pays provider `/reserve` MPP 402 challenges (Stripe/Tempo via mppx) and captures receipts. */
import { env } from "./config.js";
import { Receipt } from "mppx";

type PayFetch = typeof globalThis.fetch;
let payFetch: PayFetch | undefined;
let walletAddress: string | undefined;

export async function getPayFetch(): Promise<PayFetch> {
  if (payFetch) return payFetch;
  if (env.PAY_RAIL === "mock" || !env.MPPX_PRIVATE_KEY) {
    console.log(`[pay] rail=${env.PAY_RAIL}${env.MPPX_PRIVATE_KEY ? "" : " (no MPPX_PRIVATE_KEY)"} -> plain fetch, 402s will NOT be paid`);
    return (payFetch = globalThis.fetch.bind(globalThis));
  }
  const { Mppx, tempo } = await import("mppx/client");
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(env.MPPX_PRIVATE_KEY as `0x${string}`);
  walletAddress = account.address;
  // Tempo testnet (Moderato) chain id 42431; mainnet 4217. Restrict to testnet unless told otherwise.
  const chains = process.env.TEMPO_MAINNET === "1" ? [4217] : [42431];
  const base = globalThis.fetch.bind(globalThis);
  const mppx = Mppx.create({ methods: [tempo({ account, allowedChainIds: chains })], fetch: base });
  mppx.onCredentialCreated?.((e: any) => console.log("[pay] credential created", e?.challenge?.method ?? ""));
  mppx.onPaymentFailed?.((e: any) => console.log("[pay] payment FAILED", e?.error?.message ?? e));
  console.log(`[pay] rail=${env.PAY_RAIL} broker wallet ${walletAddress} (Tempo chain ${chains[0]})`);
  return (payFetch = mppx.fetch as PayFetch);
}
export function brokerWallet() { return walletAddress; }

export type PaidResult = { status: number; body: any; receipt?: any; receipt_ref?: string; method?: string };
/** POST JSON to a possibly payment-gated endpoint; returns body + decoded Payment-Receipt (if any). */
export async function paidPost(url: string, json: any): Promise<PaidResult> {
  const f = await getPayFetch();
  const res = await f(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(json), signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  let body: any; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  const hdr = res.headers.get("payment-receipt") ?? res.headers.get("Payment-Receipt");
  let receipt: any; if (hdr) { try { receipt = Receipt.deserialize(hdr); } catch { receipt = { raw: hdr }; } }
  if (!receipt && body?.grant?.payment?.receipt) receipt = body.grant.payment.receipt;
  return { status: res.status, body, receipt, receipt_ref: receipt?.reference ?? receipt?.externalId, method: receipt?.method };
}
