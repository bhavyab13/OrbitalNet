/**
 * Metered usage via MPP sessions (OCGP §2.10). A relay node charges per 100 KB as bytes flow,
 * over a Tempo TIP-1034 payment channel; on the Stripe rail the channel settles to the Stripe
 * balance (PaymentIntents) via Stripe's deposit address. The window reservation (`/reserve`)
 * and the signed Grant stay exactly as they are; this is usage metering on top.
 */
import { Mppx as HonoMppx } from "mppx/hono";
import { Store, tempo, stripe } from "mppx/server";
import { privateKeyToAccount } from "viem/accounts";
import type { MiddlewareHandler } from "hono";
import type { Config } from "./config.ts";

export type Settlement = { txHash: string; channelId: string; trigger: string; amount_usd: number; delta_usd: number; at: string };

export type SessionGate = {
  rail: "stripe" | "tempo" | "mock";
  /** USD charged per 100 KB unit. */
  unitUsd: number;
  unitType: string;
  /** Hono middleware that opens/validates the MPP session (absent on the mock rail). */
  middleware?: MiddlewareHandler;
  /** On-chain settlements confirmed so far (newest last). */
  settlements: Settlement[];
  operatorAddress?: string;
};

const raw6 = (n: bigint) => Number(n) / 1e6;

export async function makeSessionGate(cfg: Config): Promise<SessionGate | null> {
  const cap = cfg.node.capability ?? {};
  if (cap.type !== "relay") return null;
  // $/MB → $/100KB, rounded to a micro-dollar; e.g. 0.02/MB → 0.002 per 100 KB (5 units per cent → whole-cent settlements).
  const unitUsd = Math.max(0.000001, Math.round((Number(cap.price_per_mb ?? 0.02) / 10) * 1e6) / 1e6);
  const unitType = "100KB";
  const settlements: Settlement[] = [];
  if (cfg.PAY_RAIL === "mock") return { rail: "mock", unitUsd, unitType, settlements };

  const opKeyEnv = `TEMPO_OPERATOR_KEY_${cfg.OPERATOR_ID.replace(/-/g, "_")}`;
  const opKey = process.env.TEMPO_OPERATOR_KEY ?? process.env[opKeyEnv];
  if (!opKey) {
    console.warn(`[${cfg.NODE_ID}] no ${opKeyEnv}: metered sessions run unmetered (mock)`);
    return { rail: "mock", unitUsd, unitType, settlements };
  }
  const operator = privateKeyToAccount(opKey as `0x${string}`);
  const store = Store.memory();
  const onSessionSettlement = (ctx: any) => {
    const s: Settlement = { txHash: String(ctx.txHash), channelId: String(ctx.channelId), trigger: String(ctx.trigger), amount_usd: raw6(ctx.amount), delta_usd: raw6(ctx.delta), at: new Date().toISOString() };
    settlements.push(s);
    console.log(`[${cfg.NODE_ID}] session settlement ${s.trigger} ${s.txHash} +$${s.delta_usd.toFixed(6)} (cum $${s.amount_usd.toFixed(6)})`);
  };
  const onSessionSettlementFailure = (ctx: any) => console.warn(`[${cfg.NODE_ID}] session settlement FAILED`, ctx?.error?.message ?? ctx);
  const common = { account: operator, operator: operator.address, store, sse: true, settlementSchedule: { amount: "0.01" }, onSessionSettlement, onSessionSettlementFailure } as any;

  let method: any;
  let rail: "stripe" | "tempo" = "tempo";
  if (cfg.PAY_RAIL === "stripe" && cfg.STRIPE_SECRET_KEY && cfg.STRIPE_PROFILE_ID && (cfg as any).TEMPO_DEPOSIT_ADDRESS) {
    const Stripe = (await import("stripe")).default;
    const client = new Stripe(cfg.STRIPE_SECRET_KEY);
    const mp: any = stripe.create({ client, networkId: cfg.STRIPE_PROFILE_ID, livemode: !cfg.STRIPE_SECRET_KEY.includes("_test_"), store } as any);
    method = mp.tempo.session({ recipient: (cfg as any).TEMPO_DEPOSIT_ADDRESS, ...common });
    rail = "stripe";
  } else {
    method = tempo.session({ testnet: true, recipient: cfg.TEMPO_RECIPIENT as `0x${string}`, ...common } as any);
  }
  const mppx: any = HonoMppx.create({ methods: [method], secretKey: cfg.MPP_SECRET_KEY } as any);
  const sessionFn = typeof mppx.session === "function" ? mppx.session : mppx.tempo?.session;
  if (typeof sessionFn !== "function") throw new Error("mppx hono wrapper exposes no session() handler");
  const middleware: MiddlewareHandler = sessionFn({ amount: unitUsd.toFixed(6), unitType, suggestedDeposit: "0.10" });
  return { rail, unitUsd, unitType, middleware, settlements, operatorAddress: operator.address };
}
