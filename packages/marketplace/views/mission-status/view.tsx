/** MCP App view for get_mission_status: live mission card (auto-refreshes every 3 s). */
import { ThemeProvider, useCallTool, useToolContext } from "mcp-use/react";
import { useEffect, useState } from "react";

const C = { bg: "#0b1020", card: "#121a2e", line: "#223052", text: "#e6ecff", dim: "#8a96b8", ok: "#34d399", warn: "#fbbf24", bad: "#f87171", acc: "#4fd1ff" };
const chip = (s: string) => ({ DONE: C.ok, DELIVERED: C.ok, RUNNING: C.acc, PENDING: C.dim, FAILED: C.bad, REPLAN_REQUIRED: C.warn, INFEASIBLE: C.bad, PLANNED: C.dim }[s] ?? C.dim);
const fmt = (t?: number | null) => t == null ? "—" : `T+${Math.round(t)}s`;

export default function MissionStatusView() {
  const view = useToolContext<"get_mission_status">();
  const refresh = useCallTool("get_mission_status");
  const [tick, setTick] = useState(0);
  const missionId = (view.toolInput as any)?.mission_id;
  useEffect(() => {
    if (!missionId) return;
    const id = setInterval(() => { refresh.callTool({ mission_id: missionId }).catch(() => {}); setTick((t) => t + 1); }, 3000);
    return () => clearInterval(id);
  }, [missionId]);
  const d: any = refresh.data?.structuredContent ?? (view.status === "ready" ? view.toolOutput : undefined);

  return (
    <ThemeProvider>
      <div style={{ fontFamily: "ui-sans-serif, system-ui", background: C.bg, color: C.text, padding: 16, borderRadius: 14, border: `1px solid ${C.line}`, maxWidth: 720 }}>
        {view.status === "error" ? <div style={{ color: C.bad }}>Failed: {view.error.message}</div>
        : !d ? <div style={{ color: C.dim }}>Loading mission…</div>
        : <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div><div style={{ fontSize: 11, letterSpacing: 2, color: C.dim }}>ORBITALNET · MISSION</div><div style={{ fontSize: 20, fontWeight: 700 }}>{d.mission_id}</div></div>
            <span style={{ padding: "4px 10px", borderRadius: 999, background: chip(d.status) + "22", color: chip(d.status), fontWeight: 700, fontSize: 12 }}>{d.status}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, margin: "12px 0" }}>
            {[["Sim clock", fmt(d.sim_t)], ["Deadline", fmt(d.deadline_sim_t)], ["Spent", `$${(d.spent_usd ?? 0).toFixed(2)}`], ["Budget", `$${(d.budget_usd ?? 0).toFixed(2)}`]].map(([k, v]) => (
              <div key={k} style={{ background: C.card, borderRadius: 10, padding: 10 }}><div style={{ fontSize: 10, color: C.dim }}>{k}</div><div style={{ fontSize: 16, fontWeight: 600 }}>{v}</div></div>))}
          </div>
          <div style={{ fontSize: 11, color: C.dim, marginBottom: 6 }}>LEGS</div>
          {(d.legs ?? []).map((l: any, i: number) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0", borderTop: `1px solid ${C.line}` }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: chip(l.status) }} />
              <div style={{ flex: 1, fontSize: 13 }}>{l.kind === "compute" ? `⚙ ${l.op ?? "inference"} on ${l.node ?? l.node_id}` : `⇢ ${l.from} → ${l.to}`}<span style={{ color: C.dim }}> · {l.window_id} · {Number(l.bytes_mb ?? 0).toFixed(2)} MB</span></div>
              {l.bytes_total_mb || l.bytes_mb ? <div style={{ width: 90, height: 6, background: C.line, borderRadius: 3 }}><div style={{ width: `${Math.min(100, 100 * (l.bytes_moved_mb ?? 0) / ((l.bytes_total_mb ?? l.bytes_mb) || 1))}%`, height: 6, background: chip(l.status), borderRadius: 3 }} /></div> : null}
              <span style={{ fontSize: 11, color: chip(l.status) }}>{l.status}</span>
            </div>))}
          <div style={{ fontSize: 11, color: C.dim, margin: "12px 0 6px" }}>PAYMENTS (MPP)</div>
          {(d.payments ?? []).length === 0 ? <div style={{ fontSize: 12, color: C.dim }}>none yet</div> : (d.payments ?? []).map((p: any, i: number) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0", borderTop: `1px solid ${C.line}` }}>
              <span>{p.operator_id} <span style={{ color: C.dim }}>({p.node_id})</span></span>
              <span style={{ color: C.ok }}>${Number(p.amount_usd).toFixed(2)}</span>
              <span style={{ color: C.dim, fontFamily: "ui-monospace, monospace" }}>{p.method ?? "?"} · {(p.receipt_ref ?? "").slice(0, 14)}…</span>
            </div>))}
          {d.result ? <div style={{ marginTop: 12, background: C.card, borderRadius: 10, padding: 10, display: "flex", gap: 12 }}>
            {d.result.thumbnail_b64 ? <img alt="result" src={`data:image/png;base64,${d.result.thumbnail_b64}`} style={{ width: 120, height: 120, borderRadius: 8, objectFit: "cover" }} /> : null}
            <div style={{ fontSize: 13 }}><div style={{ fontWeight: 700, color: C.ok }}>Result delivered</div><pre style={{ whiteSpace: "pre-wrap", fontSize: 11, color: C.dim, margin: "4px 0 0" }}>{JSON.stringify(d.result.summary ?? {}, null, 1)}</pre></div>
          </div> : null}
          {d.last_event ? <div style={{ marginTop: 10, fontSize: 11, color: C.dim }}>{d.last_event}</div> : null}
          <div style={{ marginTop: 8, fontSize: 10, color: C.dim }}>auto-refresh · {tick}</div>
        </>}
      </div>
    </ThemeProvider>
  );
}
