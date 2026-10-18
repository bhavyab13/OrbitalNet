import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const SCRIPT = join(HERE, "..", "inference", "fire_detect.py");

export function pythonBin(cfg: Config): string {
  if (cfg.PYTHON) return cfg.PYTHON;
  const venv = join(cfg.ROOT, "sim", ".venv", "bin", "python");
  return existsSync(venv) ? venv : "python3";
}

export type InferenceResult = {
  model: string;
  geojson: any;
  summary: Record<string, any>;
  validation: Record<string, any> | null;
  thumbnail_b64: string | null;
};

/** Runs the real fire detector on image bytes. Resolves with parsed JSON. */
export function runFireDetector(cfg: Config, image: Uint8Array, bbox: number[], opts: { truth?: string; timeoutMs?: number } = {}): Promise<InferenceResult> {
  const dir = mkdtempSync(join(tmpdir(), "ocgp-inf-"));
  const img = join(dir, "scene.jpg");
  writeFileSync(img, image);
  const args = [SCRIPT, "--image", img, `--bbox=${bbox.join(",")}`, "--thumb-b64"];
  if (opts.truth && existsSync(opts.truth)) args.push("--truth", opts.truth);
  return new Promise((resolve, reject) => {
    const p = spawn(pythonBin(cfg), args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("inference timeout")); }, opts.timeoutMs ?? 60_000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      if (code !== 0) return reject(new Error(`fire_detect.py exit ${code}: ${err.slice(-400)}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error("bad inference output: " + String(e))); }
    });
  });
}
