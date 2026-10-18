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
const mission = { ...(scenario.mission ?? scenario) };
// Judge/operator overrides: --text "…" --deadline 900 --budget 1.5 --fidelity full|low|any
if (args.includes("--text")) mission.text = opt("--text", mission.text);
if (args.includes("--deadline")) mission.deadline_sim_t = Number(opt("--deadline", String(mission.deadline_sim_t)));
if (args.includes("--budget")) mission.budget_usd = Number(opt("--budget", String(mission.budget_usd)));
if (args.includes("--fidelity")) mission.required_fidelity = opt("--fidelity", "any");
if (args.includes("--id")) mission.mission_id = opt("--id", mission.mission_id);
const brokerUrl = opt("--broker", (process.env.BROKER_URL ?? "http://localhost:3000") + "/mcp");
const useLLM = flag("--llm") || (!flag("--auto") && !!process.env.ANTHROPIC_API_KEY);

const broker = new Broker(brokerUrl);
const tools = await broker.connect();
console.log(`connected to ${brokerUrl}; tools: ${tools.map((t) => t.name).join(", ")}`);
console.log(`mode: ${useLLM ? "LLM (" + (process.env.BUYER_MODEL ?? "claude-opus-5-5") + ")" : "deterministic"}`);
try {
  if (useLLM) await runLLM(broker, mission); else await runAuto(broker, mission);
} finally { await broker.close(); }
