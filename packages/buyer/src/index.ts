import "dotenv/config";
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Broker } from "./mcp.js";
import { runAuto } from "./auto.js";
import { runLLM } from "./llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env") });

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const scenarioPath = path.resolve(here, "../../../", opt("--mission", process.env.SCENARIO ?? "data/scenario.json"));
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
const mission = scenario.mission ?? scenario;
const brokerUrl = opt("--broker", (process.env.BROKER_URL ?? "http://localhost:3000") + "/mcp");
const useLLM = flag("--llm") || (!flag("--auto") && !!process.env.ANTHROPIC_API_KEY);

const broker = new Broker(brokerUrl);
const tools = await broker.connect();
console.log(`connected to ${brokerUrl}; tools: ${tools.map((t) => t.name).join(", ")}`);
console.log(`mode: ${useLLM ? "LLM (" + (process.env.BUYER_MODEL ?? "claude-opus-5-5") + ")" : "deterministic"}`);
try {
  if (useLLM) await runLLM(broker, mission); else await runAuto(broker, mission);
} finally { await broker.close(); }
