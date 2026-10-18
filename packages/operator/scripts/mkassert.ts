// Dev helper: mint a signed World Assertion with keys/world.json.
// usage: tsx scripts/mkassert.ts <window_id> <sim_t> [open=true] [bandwidth_mbps]
import { signAs } from "@orbitalnet/protocol";
const [window_id, simT, open = "true", bw] = process.argv.slice(2);
const wa = signAs("world", {
  sim_t: Number(simT),
  window_id,
  open: open === "true",
  bandwidth_mbps: bw ? Number(bw) : undefined,
  issued_at: new Date().toISOString(),
});
console.log(JSON.stringify(wa));
