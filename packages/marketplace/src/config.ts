import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { config as dotenv } from "dotenv";
import { PROTOCOL_TEXT, SCENARIO } from "./assets.gen.js";

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
  /** URL the sim calls back for metered relay sessions: the broker that committed a mission carries it (hosted: set in Manufact env). */
  PUBLIC_BROKER_URL: (process.env.PUBLIC_BROKER_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, ""),
};

/** First existing path among candidates (repo file, else a copy bundled in the package). */
export function findFile(...candidates: string[]): string | undefined {
  return candidates.find((p) => fs.existsSync(p));
}
/** Inlined copies (src/assets.gen.ts) are the fallback: the deployed bundle on Manufact Cloud has no
 *  monorepo on disk, so a path-based lookup finds nothing there. */
function inlined(name: string, text: string): string {
  const p = path.join(os.tmpdir(), `orbitalnet-${name}`);
  try { fs.writeFileSync(p, text); } catch { /* read-only fs: callers fall back to the inlined text */ }
  return p;
}
export const PROTOCOL_MD =
  findFile(path.join(REPO_ROOT, "docs/PROTOCOL.md"), path.join(PKG_ROOT, "PROTOCOL.md")) ?? inlined("PROTOCOL.md", PROTOCOL_TEXT);
export const SCENARIO_JSON =
  findFile(path.join(REPO_ROOT, "data/scenario.json"), path.join(PKG_ROOT, "scenario.json")) ?? inlined("scenario.json", JSON.stringify(SCENARIO));
let loaded: any = SCENARIO;
try { loaded = JSON.parse(fs.readFileSync(SCENARIO_JSON, "utf8")); } catch { /* keep inlined */ }
export const scenario: any = loaded;
