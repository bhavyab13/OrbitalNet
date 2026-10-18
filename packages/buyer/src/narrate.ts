const SIM_URL = process.env.SIM_URL ?? "http://localhost:8000";
export async function narrate(text: string, act = "buyer", extra: Record<string, unknown> = {}) {
  const line = `[buyer] ${text}`;
  console.log(line);
  try {
    await fetch(`${SIM_URL}/events`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "narration", source: "buyer", act, text, ...extra }),
    });
  } catch { /* sim offline: ignore */ }
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
