import { config as dotenv } from "dotenv";
import { readFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { repoRoot, loadKey, type KeyFile } from "@orbitalnet/protocol";

const ROOT = repoRoot();
dotenv({ path: join(ROOT, ".env") });

export type ScenarioNode = {
  node_id: string;
  role: "imaging" | "compute" | "relay";
  operator_id: string;
  operator_name: string;
  service_port?: number;
  capability?: Record<string, any>;
  joins_late?: boolean;
};
export type Scenario = {
  scenario_id: string;
  sim: { accel: number };
  mission: { mission_id: string; scene: { bbox: number[]; image_file: string; truth_csv: string } };
  nodes: ScenarioNode[];
  windows: { window_id: string; from: string; to: string; start: number; end: number; bandwidth_mbps: number; kind: string }[];
};

function env(name: string, dflt?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (dflt !== undefined) return dflt;
    throw new Error(`missing env ${name}`);
  }
  return v;
}

export function loadScenario(): Scenario {
  const p = process.env.SCENARIO ?? "data/scenario.json";
  const abs = isAbsolute(p) ? p : resolve(ROOT, p);
  return JSON.parse(readFileSync(abs, "utf8")) as Scenario;
}

export function loadConfig() {
  const scenario = loadScenario();
  const NODE_ID = env("NODE_ID");
  const node = scenario.nodes.find((n) => n.node_id === NODE_ID);
  if (!node) throw new Error(`node ${NODE_ID} not in scenario`);
  const OPERATOR_ID = env("OPERATOR_ID", node.operator_id);
  const KID = env("KID", OPERATOR_ID);
  const PORT = Number(env("PORT", String(node.service_port ?? 7000)));
  const PUBLIC_URL = env("PUBLIC_URL", `http://localhost:${PORT}`);
  const SIM_URL = env("SIM_URL", "http://localhost:8000");
  const BROKER_URL = env("BROKER_URL", "http://localhost:3000");
  const PAY_RAIL = env("PAY_RAIL", "tempo") as "tempo" | "stripe" | "mock";
  const TEMPO_RECIPIENT =
    process.env.TEMPO_RECIPIENT ?? process.env[`TEMPO_RECIPIENT_${OPERATOR_ID.replace(/-/g, "_")}`] ?? "";
  let key: KeyFile;
  try {
    key = loadKey(KID);
  } catch {
    // ephemeral key if none provisioned (e.g. a brand-new provider on a fresh box)
    const { generateKey } = require("@orbitalnet/protocol") as typeof import("@orbitalnet/protocol");
    key = generateKey(KID);
  }
  let worldPub = process.env.WORLD_PUBKEY ?? "";
  if (!worldPub) {
    try {
      worldPub = loadKey("world").public_key;
    } catch {
      /* fetched from sim at boot */
    }
  }
  return {
    ROOT,
    scenario,
    node,
    NODE_ID,
    OPERATOR_ID,
    OPERATOR_NAME: node.operator_name,
    KID,
    PORT,
    PUBLIC_URL,
    SIM_URL,
    BROKER_URL,
    PAY_RAIL,
    TEMPO_RECIPIENT,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "",
    STRIPE_PROFILE_ID: process.env.STRIPE_PROFILE_ID ?? "",
    TEMPO_DEPOSIT_ADDRESS: process.env.TEMPO_DEPOSIT_ADDRESS ?? "",
    MPP_SECRET_KEY: env("MPP_SECRET_KEY", "b3JiaXRhbG5ldC1kZXYtc2VjcmV0LWtleS0zMmJ5dGVzLW1pbmltdW0="),
    ADMIN_TOKEN: env("ADMIN_TOKEN", "judge-556677"),
    key,
    worldPub,
    PYTHON: process.env.PYTHON ?? "",
  };
}
export type Config = ReturnType<typeof loadConfig>;
