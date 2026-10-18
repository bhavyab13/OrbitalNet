/** Client for the World/planner service (sim, docs/API.md §1), with MOCK_SIM=1 canned mode. */
import { env, scenario } from "./config.js";

export async function simFetch(path: string, init?: RequestInit & { json?: any }): Promise<any> {
  if (env.MOCK_SIM) return mock(path, init);
  const headers: Record<string, string> = { accept: "application/json", ...(init?.headers as any) };
  let body = init?.body;
  if (init?.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(init.json); }
  const res = await fetch(env.SIM_URL + path, { ...init, headers, body, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`sim ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return data;
}
/** Fire-and-forget narration/event into the world's audit feed. */
export function emit(ev: Record<string, any>) {
  simFetch("/events", { method: "POST", json: { source: "broker", ts: new Date().toISOString(), ...ev } }).catch(() => {});
}

// ---------------- MOCK ----------------
let mockT = 0; const mockMissions = new Map<string, any>();
function mock(path: string, init?: any): any {
  const body = init?.json ?? {};
  const W = scenario.windows ?? [];
  if (path === "/state") return { sim_t: (mockT += 5), real_accel: 4, paused: false, nodes: scenario.nodes, ground_stations: scenario.ground_stations, windows: W.map((w: any) => ({ ...w, status: w.start > mockT ? "future" : w.end < mockT ? "closed" : "open" })), missions: Object.fromEntries(mockMissions), events_tail: [] };
  if (path === "/windows") return W.map((w: any) => ({ ...w, status: "future", remaining_mb: w.bandwidth_mbps * (w.end - w.start) / 8 }));
  if (path === "/plan") {
    const q: any[] = body.quotes ?? []; const price = (wid: string, cap?: string) => q.find((x) => x.window_id === wid && (!cap || x.capability === cap))?.price_usd;
    const qid = (wid: string, cap?: string) => q.find((x) => x.window_id === wid && (!cap || x.capability === cap))?.quote_id;
    const mb = body.payload_mb ?? 180, rmb = body.result_mb_estimate ?? 0.04;
    const src = body.committed?.node_id ?? body.source_node;
    const leg = (o: any) => ({ bytes_mb: mb, duration_s: 10, ...o });
    const plans: any[] = [];
    if (src === "SENTINEL-2A") {
      plans.push({ plan_id: "p_own", label: "Own downlink (SENTINEL-2A → GS-SVALBARD)", legs: [leg({ kind: "transfer", from: "SENTINEL-2A", to: "GS-SVALBARD", window_id: "w_A_GS_own", start: 1500, end: 1505, price_usd: 0 })], delivery_sim_t: 1505, cost_usd: 0, feasible: false, reasons: ["delivery 1505 > deadline " + body.deadline_sim_t] });
      const pC = price("w_A_C_1", "relay"), pCg = price("w_C_GS_1", "relay");
      plans.push({ plan_id: "p_raw_C", label: "Raw relay via EDRS-C", legs: [leg({ kind: "transfer", from: "SENTINEL-2A", to: "EDRS-C", window_id: "w_A_C_1", start: 40, end: 97.6, duration_s: 57.6, operator_id: "lumen-relay", node_id: "EDRS-C", capability: "relay", quote_id: qid("w_A_C_1", "relay"), price_usd: pC }), leg({ kind: "transfer", from: "EDRS-C", to: "GS-PUNTA-ARENAS", window_id: "w_C_GS_1", start: 300, end: 328.8, duration_s: 28.8, operator_id: "lumen-relay", node_id: "EDRS-C", capability: "relay", quote_id: qid("w_C_GS_1", "relay"), price_usd: pCg })], delivery_sim_t: null, cost_usd: (pC ?? 3.6) + (pCg ?? 3.6), feasible: false, reasons: ["180 MB does not fit w_A_C_1 (125 MB capacity)", "cost exceeds budget"] });
      const pB = price("w_A_B_1", "compute"), pBC = price("w_B_C_1", "relay"), pCg2 = price("w_C_GS_1", "relay");
      const cost = (pB ?? 1.95) + (pBC ?? 0.5) + (pCg2 ?? 0.5);
      plans.push({ plan_id: "p_B_C", label: "Inference on PHISAT-2 → relay EDRS-C → GS-PUNTA-ARENAS", legs: [leg({ kind: "transfer", from: "SENTINEL-2A", to: "PHISAT-2", window_id: "w_A_B_1", start: 60, end: 74.4, duration_s: 14.4, price_usd: 0 }), leg({ kind: "compute", node: "PHISAT-2", window_id: "w_A_B_1", start: 74.4, end: 119.4, duration_s: 45, operator_id: "orbital-foundry", node_id: "PHISAT-2", capability: "compute", quote_id: qid("w_A_B_1", "compute"), price_usd: pB, bytes_mb: mb }), leg({ kind: "transfer", from: "PHISAT-2", to: "EDRS-C", window_id: "w_B_C_1", start: 200, end: 200.02, duration_s: 0.02, bytes_mb: rmb, operator_id: "lumen-relay", node_id: "EDRS-C", capability: "relay", quote_id: qid("w_B_C_1", "relay"), price_usd: pBC }), leg({ kind: "transfer", from: "EDRS-C", to: "GS-PUNTA-ARENAS", window_id: "w_C_GS_1", start: 300, end: 300.01, duration_s: 0.01, bytes_mb: rmb, operator_id: "lumen-relay", node_id: "EDRS-C", capability: "relay", quote_id: qid("w_C_GS_1", "relay"), price_usd: pCg2 })], delivery_sim_t: 300.01, cost_usd: cost, feasible: q.length > 0 && cost <= body.budget_usd, reasons: q.length ? [] : ["no quote"] });
    } else {
      const pD = price("w_B_D_1", "relay"), pDg = price("w_D_GS_1", "relay");
      plans.push({ plan_id: "p_B_D", label: "Relay via STARLINK-3005 → GS-OREGON", legs: [leg({ kind: "transfer", from: "PHISAT-2", to: "STARLINK-3005", window_id: "w_B_D_1", start: 380, end: 380.01, bytes_mb: rmb, operator_id: "northstar-relay", node_id: "STARLINK-3005", capability: "relay", quote_id: qid("w_B_D_1", "relay"), price_usd: pD }), leg({ kind: "transfer", from: "STARLINK-3005", to: "GS-OREGON", window_id: "w_D_GS_1", start: 430, end: 430.01, bytes_mb: rmb, operator_id: "northstar-relay", node_id: "STARLINK-3005", capability: "relay", quote_id: qid("w_D_GS_1", "relay"), price_usd: pDg })], delivery_sim_t: 430.01, cost_usd: (pD ?? 0.5) + (pDg ?? 0.5), feasible: q.length > 0, reasons: q.length ? [] : ["no quote"] });
    }
    return { plans };
  }
  if (path === "/missions" && init?.method === "POST") { const m = { mission_id: body.mission?.mission_id ?? "fire-001", status: "RUNNING", current_leg: 0, legs: (body.plan?.legs ?? []).map((l: any) => ({ ...l, status: "PENDING", bytes_moved_mb: 0 })), audit: [], polls: 0 }; mockMissions.set(m.mission_id, m); return { mission_id: m.mission_id, status: "RUNNING" }; }
  if (path.match(/^\/missions\/[^/]+\/resume$/)) { const id = path.split("/")[2]; const m = mockMissions.get(id) ?? { mission_id: id, audit: [] }; m.status = "RUNNING"; m.legs = (body.plan?.legs ?? []).map((l: any) => ({ ...l, status: "PENDING", bytes_moved_mb: 0 })); m.current_leg = 0; m.polls = 0; mockMissions.set(id, m); return { mission_id: id, status: "RUNNING" }; }
  if (path.startsWith("/missions/")) { const id = path.split("/")[2]; const m = mockMissions.get(id); if (!m) throw new Error("sim /missions/" + id + " -> 404"); m.polls++; const i = Math.min(m.polls - 1, m.legs.length); m.legs.forEach((l: any, k: number) => { l.status = k < i ? "DONE" : k === i ? "RUNNING" : "PENDING"; l.bytes_moved_mb = k < i ? l.bytes_mb : 0; }); m.current_leg = i; if (i >= m.legs.length) { m.status = "DELIVERED"; m.result = { summary: { fire_pixels: 4210, clusters: 17, bbox: scenario.mission?.scene?.bbox }, geojson: { type: "FeatureCollection", features: [] } }; } return { ...m, sim_t: mockT }; }
  if (path === "/disrupt") return { ok: true, event: { type: body.type, ...body } };
  if (path === "/reset") { mockMissions.clear(); mockT = 0; return { ok: true }; }
  if (path === "/events") return { ok: true };
  if (path === "/clock") return { ok: true, sim_t: mockT };
  throw new Error("mock sim: unknown path " + path);
}
