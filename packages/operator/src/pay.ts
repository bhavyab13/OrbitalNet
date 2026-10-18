/**
 * MPP payment gate. Uses the mppx core server so the handler can read the receipt
 * object (needed inside the Grant). Rails: tempo (testnet, no Stripe account needed),
 * stripe (Stripe sandbox machine payments: SPT + Tempo via Stripe), mock.
 */
import { Mppx, Store, tempo, stripe } from "mppx/server";
import { Receipt } from "mppx";
import type { Config } from "./config.ts";

export type ChargeResult = { status: 402; challenge: Response } | { status: 200; receipt: Record<string, any>; method: string; attach: (r: Response) => Promise<Response> };

export async function makePayments(cfg: Config) {
  if (cfg.PAY_RAIL === "mock") {
    return {
      rail: "mock",
      methods: ["mock"],
      recipient: "",
      async charge(_req: Request, amount: string, description: string): Promise<ChargeResult> {
        const receipt = { method: "mock", status: "success", reference: `mock_${Math.random().toString(36).slice(2, 10)}`, timestamp: new Date().toISOString(), amount, description };
        return { status: 200, receipt, method: "mock", attach: async (r) => r };
      },
    };
  }
  let methods: any;
  let methodNames: string[];
  let recipient = cfg.TEMPO_RECIPIENT;
  if (cfg.PAY_RAIL === "stripe") {
    if (!cfg.STRIPE_SECRET_KEY || !cfg.STRIPE_PROFILE_ID) throw new Error("PAY_RAIL=stripe needs STRIPE_SECRET_KEY and STRIPE_PROFILE_ID");
    const Stripe = (await import("stripe")).default;
    const client = new Stripe(cfg.STRIPE_SECRET_KEY);
    // depositAddresses enables the Tempo method through Stripe (sandbox key -> Tempo testnet); without it only SPT cards are offered.
    const dep = (cfg as any).TEMPO_DEPOSIT_ADDRESS ? { depositAddresses: { tempo: (cfg as any).TEMPO_DEPOSIT_ADDRESS } } : {};
    const mp = stripe.create({ client, networkId: cfg.STRIPE_PROFILE_ID, livemode: !cfg.STRIPE_SECRET_KEY.includes("_test_"), store: Store.memory(), ...dep } as any);
    methods = await (mp as any).defaultMethods();
    methodNames = ["tempo", "spt"];
    recipient = cfg.STRIPE_PROFILE_ID;
  } else {
    if (!recipient) throw new Error("PAY_RAIL=tempo needs TEMPO_RECIPIENT (or TEMPO_RECIPIENT_<operator_id>)");
    methods = [tempo({ testnet: true, recipient: recipient as `0x${string}` })];
    methodNames = ["tempo"];
  }
  const core = Mppx.create({ methods, secretKey: cfg.MPP_SECRET_KEY, store: Store.memory() } as any);
  return {
    rail: cfg.PAY_RAIL,
    methods: methodNames,
    recipient,
    async charge(req: Request, amount: string, description: string): Promise<ChargeResult> {
      const r: any = await (core as any).charge({ amount, description })(req);
      if (r.status === 402) return { status: 402, challenge: r.challenge as Response };
      // Obtain the receipt by letting mppx attach it to a throwaway response, then decode the header.
      const probe = await r.withReceipt(new Response(null, { status: 200 }));
      const hdr = probe.headers.get("Payment-Receipt");
      const receipt = hdr ? (Receipt.deserialize(hdr) as Record<string, any>) : { method: "unknown", status: "success", reference: "", timestamp: new Date().toISOString() };
      return { status: 200, receipt, method: String(receipt.method ?? methodNames[0]), attach: (resp: Response) => r.withReceipt(resp) };
    },
  };
}
export type Payments = Awaited<ReturnType<typeof makePayments>>;
