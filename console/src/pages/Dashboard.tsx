import { ArrowRight, Pulse } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, formatBytes, formatDuration, formatNumber, timeAgo, useEvents } from "../api";
import { useCrumbs } from "../App";
import Chart from "../components/charts/Chart";
import { Empty, StatusPill, Tile } from "../components/ui";
import type { LoomEvent, Run, Stats, Workflow } from "../types";

function describe(ev: LoomEvent): { kind: string; text: string; to?: string } {
  switch (ev.type) {
    case "run_updated":
      return { kind: "run", text: `${ev.run.workflow_name} → ${ev.run.state}`, to: `/runs/${ev.run.id}` };
    case "task_updated":
      return { kind: "task", text: `${ev.task.task_id} → ${ev.task.state}`, to: `/runs/${ev.task.run_id}` };
    case "log":
      return { kind: "log", text: `[${ev.task_id}] ${ev.line}`, to: `/runs/${ev.run_id}` };
    case "ingested":
      return { kind: "ingest", text: `${ev.records.toLocaleString()} records (${formatBytes(ev.bytes)}) into ${ev.dataset}`, to: `/data?dataset=${ev.dataset}` };
    case "function_invoked":
      return { kind: "invoke", text: `${ev.name} ${ev.ok ? "succeeded" : "failed"} in ${ev.duration_ms}ms`, to: `/functions?name=${ev.name}` };
  }
}

const STATE_COLORS = { completed: "var(--good)", failed: "var(--critical)", running: "var(--running)", cancelled: "var(--ink-4)" };

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [feed, setFeed] = useState<LoomEvent[]>([]);
  const navigate = useNavigate();
  useCrumbs([{ label: "Dashboard" }]);

  const refresh = useCallback(() => {
    api.get<Stats>("/api/stats").then(setStats).catch(() => {});
    api.get<Run[]>("/api/runs?limit=500").then(setRuns).catch(() => {});
    api.get<Workflow[]>("/api/workflows").then(setWorkflows).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  useEvents((ev) => {
    setFeed((prev) => [ev, ...prev].slice(0, 80));
    if (ev.type === "run_updated" || ev.type === "ingested" || ev.type === "function_invoked") refresh();
  });

  const { activity, hourly, avgMs, medianMs } = useMemo(() => {
    const now = Date.now();
    const rows: Array<{ hour: string; state: string; count: number }> = [];
    const hourly = new Array(24).fill(0);
    const byHour = new Map<number, Record<string, number>>();
    const durations: number[] = [];
    for (const r of runs) {
      const age = now - new Date(r.created_at).getTime();
      if (age >= 0 && age <= 24 * 3600_000) {
        const idx = 23 - Math.floor(age / 3600_000);
        hourly[idx]++;
        const rec = byHour.get(idx) ?? {};
        rec[r.state] = (rec[r.state] ?? 0) + 1;
        byHour.set(idx, rec);
      }
      if (r.started_at && r.finished_at && r.state === "completed") durations.push(new Date(r.finished_at).getTime() - new Date(r.started_at).getTime());
    }
    for (let i = 0; i < 24; i++) {
      const label = i === 23 ? "now" : `-${23 - i}h`;
      const rec = byHour.get(i) ?? {};
      for (const st of ["completed", "failed", "running", "cancelled"]) rows.push({ hour: label, state: st, count: rec[st] ?? 0 });
    }
    durations.sort((a, b) => a - b);
    return {
      activity: rows,
      hourly,
      avgMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      medianMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
    };
  }, [runs]);

  const successRate = stats && stats.runs_completed + stats.runs_failed > 0 ? Math.round((stats.runs_completed / (stats.runs_completed + stats.runs_failed)) * 100) : null;
  const active = runs.filter((r) => r.state === "running" || r.state === "pending");
  const scheduled = workflows.filter((w) => w.spec.triggers.every_secs || w.spec.triggers.on_ingest).length;

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Orchestration, workloads, and ingestion, live.</p>
        </div>
      </div>

      <div className="tiles">
        <Tile label="Runs · 24h" value={hourly.reduce((a, b) => a + b, 0)} sub={`${stats?.runs_total ?? "…"} all time`} spark={hourly} />
        <Tile label="Active runs" value={stats?.runs_running ?? "—"} tone={active.length ? "accent" : undefined} sub={active.length ? active.map((r) => r.workflow_name).slice(0, 2).join(", ") : "nothing running"} />
        <Tile label="Success rate" value={successRate === null ? "—" : `${successRate}%`} sub={stats ? `${stats.runs_completed} ok · ${stats.runs_failed} failed` : undefined} tone={successRate !== null && successRate < 80 ? "bad" : successRate !== null ? "good" : undefined} />
        <Tile label="Median run time" value={medianMs !== null ? formatDuration(new Date(0).toISOString(), new Date(medianMs).toISOString()) : "—"} sub={avgMs !== null ? `avg ${Math.round(avgMs)}ms` : undefined} />
        <Tile label="Workflows" value={stats?.workflows ?? "—"} sub={`${scheduled} scheduled · ${stats?.functions ?? 0} functions`} />
        <Tile label="Ingested" value={stats ? formatBytes(stats.bytes_ingested) : "—"} sub={stats ? `${formatNumber(stats.records_ingested)} records · ${stats.datasets} datasets` : undefined} />
      </div>

      <div className="grid-2" style={{ gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)" }}>
        <div className="card">
          <div className="card-head">
            <h2>Runs by hour <span className="sub">last 24 hours</span></h2>
          </div>
          <div className="card-body" style={{ paddingBottom: 8 }}>
            <Chart rows={activity} spec={{ mark: "bar", x: "hour", y: ["count"], color: "state", stack: true, agg: "sum" }} height={200} colors={STATE_COLORS} />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2><Pulse size={15} /> Live activity</h2>
            <span className="sub">{feed.length ? `${feed.length} recent events` : "streaming"}</span>
          </div>
          <div className="feed" style={{ maxHeight: 262 }}>
            {feed.length === 0 ? (
              <Empty title="Quiet for now" hint="Run, task, log, ingest, and invocation events stream here in real time." />
            ) : (
              feed.map((ev, i) => {
                const d = describe(ev);
                return (
                  <div className="feed-item" key={i} style={{ cursor: d.to ? "pointer" : "default" }} onClick={() => d.to && navigate(d.to)}>
                    <span className="ts">{new Date(ev.ts).toLocaleTimeString()}</span>
                    <span className="k">{d.kind}</span>
                    <span className="truncate">{d.text}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Recent runs</h2>
          <Link to="/runs" className="small">All runs <ArrowRight size={12} /></Link>
        </div>
        {runs.length === 0 ? (
          <Empty title="No runs yet" hint="Trigger a workflow to see it here." action={<Link className="btn sm" to="/workflows">Go to workflows</Link>} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Workflow</th>
                <th>State</th>
                <th>Trigger</th>
                <th className="num">Duration</th>
                <th className="num">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.slice(0, 8).map((r) => (
                <tr key={r.id} className="rowlink" onClick={() => navigate(`/runs/${r.id}`)}>
                  <td className="primary">{r.workflow_name}</td>
                  <td><StatusPill state={r.state} /></td>
                  <td><span className="chip">{r.trigger}</span></td>
                  <td className="num">{formatDuration(r.started_at, r.finished_at)}</td>
                  <td className="num muted">{timeAgo(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
