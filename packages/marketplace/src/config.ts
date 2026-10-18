import path from "node:path";
import fs from "node:fs";
import { config as dotenv } from "dotenv";

const here = path.dirname(new URL(import.meta.url).pathname);
export const PKG_ROOT = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(PKG_ROOT, "../..");
for (const p of [path.join(REPO_ROOT, ".env"), path.join(PKG_ROOT, ".env")]) {
  if (fs.existsSync(p)) dotenv({ path: p, override: false });
}

export const env = {
  SIM_URL: (process.env.SIM_URL ?? "http://localhost:8000").replace(/\/$/, ""),
  REGISTRY_SEED: (process.env.REGISTRY_SEED ?? "http://localhost:7001,http://localhost:7002")
    .split(",").map((s) => s.trim()).filter(Boolean),
  MPPX_PRIVATE_KEY: process.env.MPPX_PRIVATE_KEY,
  PAY_RAIL: process.env.PAY_RAIL ?? "tempo",
  BROKER_KID: process.env.BROKER_KID ?? "broker",
  MOCK_SIM: process.env.MOCK_SIM === "1",
  MPP_GATE_TOOLS: process.env.MPP_GATE_TOOLS === "1",
  ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? "judge-556677",
};

/** First existing path among candidates (repo file, else a copy bundled in the package). */
export function findFile(...candidates: string[]): string | undefined {
  return candidates.find((p) => fs.existsSync(p));
}
export const PROTOCOL_MD =
  findFile(path.join(REPO_ROOT, "docs/PROTOCOL.md"), path.join(PKG_ROOT, "PROTOCOL.md"));
export const SCENARIO_JSON =
  findFile(path.join(REPO_ROOT, "data/scenario.json"), path.join(PKG_ROOT, "scenario.json"));
export const scenario: any = SCENARIO_JSON ? JSON.parse(fs.readFileSync(SCENARIO_JSON, "utf8")) : {};
