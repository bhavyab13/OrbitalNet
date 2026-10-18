/**
 * Deterministic buyer (no LLM). Same protocol flow as the LLM buyer, used when
 * ANTHROPIC_API_KEY is absent or --auto is passed. Chooses the feasible plan with
 * the earliest delivery whose cost fits the budget.
 */
import { Broker } from "./mcp.js";
import { narrate, sleep } from "./narrate.js";

type Plan = { plan_id: string; label: string; feasible: boolean; delivery_sim_t?: number; cost_usd?: number; reasons?: string[]; legs?: any[] };

export function choosePlan(plans: Plan[], budget: number): Plan | undefined {
  const ok = plans.filter((p) => p.feasible && (p.cost_usd ?? Infinity) <= budget);
  ok.sort((a, b) => (a.delivery_sim_t ?? 1e9) - (b.delivery_sim_t ?? 1e9) || (a.cost_usd ?? 0) - (b.cost_usd ?? 0));
  return ok[0];
}

export function planTable(plans: Plan[]): string {
  return plans.map((p: any) => `  ${p.feasible ? "✓" : "✗"} ${String(p.fidelity ?? "full").padEnd(4)} ${p.label.padEnd(58)} T+${String(Math.round(p.delivery_sim_t ?? 0) || "—").padStart(5)}s  $${(p.cost_usd ?? 0).toFixed(2)}  ${p.feasible ? (p.tradeoff ?? "") : (p.reasons ?? []).join("; ")}`).join("\n");
}

export async function runAuto(broker: Broker, mission: any) {
  const mission_id = mission.mission_id;
  const budget = mission.budget_usd; // the broker tracks what has been paid/refunded and reports budget_remaining_usd
  let remaining = budget;
  let preserve: any = undefined;
  let attempt = 0;
  let submitted = false; // resume only once the sim knows the mission

  await narrate(`Mission ${mission_id} received: "${mission.text}"`, "arrival");

  while (attempt++ < 4) {
    const disc = await broker.call("discover_providers", {});
    const names = (disc.providers ?? []).map((p: any) => `${p.operator_name ?? p.operator_id}@${p.node_id}${p.verified ? " (sig ok)" : " (UNVERIFIED)"}`);
    await narrate(`Discovered ${names.length} independent providers: ${names.join(", ")}`, "discover");

    const planRes = await broker.call("plan_mission", {
      mission_id, source_node: mission.source_node, payload_mb: mission.payload_mb, op: mission.op, model: mission.model,
      result_mb_estimate: mission.result_mb_estimate, deadline_sim_t: mission.deadline_sim_t, budget_usd: budget, preserve,
    });
    const plans: Plan[] = planRes.plans ?? [];
    remaining = planRes.budget_remaining_usd ?? remaining;
    console.log(planTable(plans));
    let chosen = choosePlan(plans, remaining);
    if (!chosen) {
      // OCGP §4.5 / §5: no feasible path NOW does not mean never. Providers can join at any time (self-describing
      // manifests), so watch the registry until the deadline, replanning whenever the provider set changes.
      const simNow = async () => Number((await broker.call("get_contact_windows", {})).sim_t ?? 0);
      let known = (disc.providers ?? []).filter((p: any) => p.online !== false).length;
      await narrate(`No feasible path with the ${known} providers online (deadline T+${mission.deadline_sim_t}s). Not inventing a result — watching the marketplace for new capacity until the deadline.`, "waiting");
      while (!chosen) {
        await sleep(3000);
        const t = await simNow();
        if (t >= mission.deadline_sim_t) {
          await narrate(`Deadline T+${mission.deadline_sim_t}s passed with no feasible path. Mission INFEASIBLE.`, "infeasible");
          return { status: "INFEASIBLE" };
        }
        const d2 = await broker.call("discover_providers", {});
        const online = (d2.providers ?? []).filter((p: any) => p.online !== false);
        if (online.length === known) continue;
        const newcomers = online.filter((p: any) => !(disc.providers ?? []).some((q: any) => q.operator_id === p.operator_id && q.online !== false)).map((p: any) => `${p.operator_name ?? p.operator_id}@${p.node_id}${p.verified ? " (sig ok)" : " (UNVERIFIED)"}`);
        known = online.length;
        await narrate(`New provider online: ${newcomers.join(", ")}. Manifest verified from its signature alone — no integration code. Replanning.`, "discover");
        const pr2 = await broker.call("plan_mission", {
          mission_id, source_node: mission.source_node, payload_mb: mission.payload_mb, op: mission.op, model: mission.model,
          result_mb_estimate: mission.result_mb_estimate, deadline_sim_t: mission.deadline_sim_t, budget_usd: budget, preserve,
        });
        const plans2: Plan[] = pr2.plans ?? []; remaining = pr2.budget_remaining_usd ?? remaining;
        console.log(planTable(plans2));
        chosen = choosePlan(plans2, remaining);
      }
    }
    await narrate(`Chose "${chosen.label}": delivery T+${chosen.delivery_sim_t}s for $${chosen.cost_usd?.toFixed(2)} (${plans.filter(p=>!p.feasible).length} alternatives infeasible).`, "path-found", { plan_id: chosen.plan_id });

    const res = await broker.call("reserve_path", { mission_id, plan_id: chosen.plan_id, holder: mission.buyer_id ?? "buyer:emergency-ops" });
    if (!res.ok) {
      await narrate(`Reservation failed (${res.reason}); holds released, no money moved. Replanning.`, "replan");
      continue;
    }
    remaining -= res.total_usd ?? 0;
    await narrate(`Paid ${res.receipts?.length ?? 0} providers $${(res.total_usd ?? 0).toFixed(2)} via MPP; holding ${res.grants?.length ?? 0} signed grants. Remaining budget $${remaining.toFixed(2)}.`, "paid");

    await broker.call("submit_mission", { mission_id, plan_id: chosen.plan_id, resume: submitted });
    submitted = true;
    await narrate(`Mission submitted for execution.`, "executing");

    // Poll until terminal or replan
    let status: any;
    for (let i = 0; i < 600; i++) {
      await sleep(2000);
      status = await broker.call("get_mission_status", { mission_id });
      const s = status.status ?? status.mission?.status;
      if (s === "DELIVERED") {
        const find = (o: any, k: string): any => { if (!o || typeof o !== "object") return undefined; if (k in o && o[k] != null) return o[k]; for (const v of Object.values(o)) { const r = find(v, k); if (r !== undefined) return r; } return undefined; };
        const t = find(status, "delivered_sim_t"); const paid = find(status, "total_paid_usd");
        await narrate(`Delivered at T+${t !== undefined ? Math.round(Number(t)) : "?"}s (deadline T+${mission.deadline_sim_t}s), total paid $${Number(paid ?? 0).toFixed(2)}. Audit: ${find(status, "audit")?.length ?? 0} entries.`, "delivered"); return status;
      }
      if (s === "INFEASIBLE" || s === "FAILED") { await narrate(`Mission ended: ${s}.`, "infeasible"); return status; }
      if (s === "REPLAN_REQUIRED") {
        const refundEntries = status.refunds ?? (status.audit ?? []).filter((a: any) => a.type === "refund" && a.amount_usd);
        const seen = new Set<string>();
        const refunded = refundEntries.filter((r: any) => { const k = r.grant_id ?? r.voucher_id ?? JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; }).reduce((a: number, r: any) => a + Number(r.amount_usd ?? 0), 0);
        remaining += refunded;
        preserve = status.committed ?? status.mission?.committed;
        await narrate(`Disruption: ${status.reason ?? "leg failed"}. Committed work preserved at ${preserve?.node_id ?? "source"}; $${refunded.toFixed(2)} refunded. Replanning from current state.`, "replan");
        break;
      }
    }
  }
  return { status: "GAVE_UP" };
}
