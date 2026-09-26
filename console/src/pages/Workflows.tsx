import { GitBranch, Plus } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, formatMs, timeAgo, useEvents } from "../api";
import { useCrumbs } from "../App";
import { Empty, RuntimeBadge, StatusPill } from "../components/ui";
import WorkflowBuilder from "../components/WorkflowBuilder";
import type { Run, Workflow, WorkflowSpec } from "../types";

export interface WorkflowMetrics {
  last?: Run;
  history: Run[]; // newest first
  total: number;
  completed: number;
  failed: number;
  avgMs: number | null;
}

export function computeMetrics(runs: Run[]): WorkflowMetrics {
  const completedRuns = runs.filter((r) => r.state === "completed");
  const durations = completedRuns
    .map((r) => (r.started_at && r.finished_at ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime() : null))
    .filter((d): d is number => d !== null);
  return {
    last: runs[0],
    history: runs.slice(0, 16),
    total: runs.length,
    completed: completedRuns.length,
    failed: runs.filter((r) => r.state === "failed").length,
    avgMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
  };
}

export function HistoryBars({ history }: { history: Run[] }) {
  const ordered = [...history].reverse();
  const durations = ordered.map((r) => (r.started_at && r.finished_at ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime() : null));
  const max = Math.max(1, ...durations.filter((d): d is number => d !== null));
  return (
    <span className="history-bars" title="Recent runs, oldest to newest (height = duration)">
      {ordered.map((r, i) => {
        const h = durations[i] === null ? 8 : Math.max(5, (durations[i]! / max) * 22);
        return <span key={r.id} className={r.state} style={{ height: `${h}px` }} />;
      })}
    </span>
  );
}

export { formatMs };

export default function Workflows() {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [params, setParams] = useSearchParams();
  const creating = params.get("new") === "1";
  const navigate = useNavigate();
  useCrumbs([{ label: "Workflows" }]);

  const refresh = useCallback(() => {
    api.get<Workflow[]>("/api/workflows").then(setWorkflows).catch(() => setWorkflows([]));
    api.get<Run[]>("/api/runs?limit=500").then(setRuns).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  useEvents((ev) => {
    if (ev.type === "run_updated") {
      setRuns((prev) => {
        const idx = prev.findIndex((r) => r.id === ev.run.id);
        if (idx === -1) return [ev.run, ...prev];
        const next = [...prev];
        next[idx] = ev.run;
        return next;
      });
    }
  });

  const metricsByWorkflow = useMemo(() => {
    const grouped = new Map<string, Run[]>();
    for (const r of runs) grouped.set(r.workflow_id, [...(grouped.get(r.workflow_id) ?? []), r]);
    const out = new Map<string, WorkflowMetrics>();
    for (const [id, rs] of grouped) out.set(id, computeMetrics(rs));
    return out;
  }, [runs]);

  const create = async (spec: WorkflowSpec) => {
    const wf = await api.post<Workflow>("/api/workflows", spec);
    navigate(`/workflows/${wf.id}`);
  };

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Workflows</h1>
          <p>DAGs of Python and TypeScript tasks, scheduled and run in parallel by the Rust core.</p>
        </div>
        <button className="btn primary" onClick={() => setParams(creating ? {} : { new: "1" })}>
          {creating ? "Close" : <><Plus size={14} weight="bold" /> New workflow</>}
        </button>
      </div>

      {creating && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h2>New workflow</h2></div>
          <div className="card-body"><WorkflowBuilder submitLabel="Create workflow" onSubmit={create} /></div>
        </div>
      )}

      <div className="card">
        {workflows === null ? (
          <div style={{ padding: 16 }}><div className="skeleton" style={{ height: 14 }} /></div>
        ) : workflows.length === 0 ? (
          <Empty icon={<GitBranch size={20} />} title="No workflows yet" hint="Create one here, or deploy from the Python / TypeScript SDK." action={<button className="btn primary sm" onClick={() => setParams({ new: "1" })}>New workflow</button>} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Last run</th>
                <th>History</th>
                <th className="num">Success</th>
                <th className="num">Avg time</th>
                <th>Triggers</th>
                <th>Runtimes</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((wf) => {
                const m = metricsByWorkflow.get(wf.id);
                const runtimes = [...new Set(wf.spec.tasks.map((t) => t.runtime))];
                const triggers = [
                  wf.spec.triggers.every_secs ? `every ${wf.spec.triggers.every_secs}s` : null,
                  wf.spec.triggers.on_ingest ? `ingest: ${wf.spec.triggers.on_ingest}` : null,
                ].filter(Boolean);
                const successPct = m && m.completed + m.failed > 0 ? Math.round((m.completed / (m.completed + m.failed)) * 100) : null;
                return (
                  <tr key={wf.id} className="rowlink" onClick={() => navigate(`/workflows/${wf.id}`)}>
                    <td>
                      <div className="primary">{wf.spec.name}</div>
                      <div className="muted small">
                        {wf.spec.tasks.length} task{wf.spec.tasks.length === 1 ? "" : "s"}
                        {wf.spec.description ? ` · ${wf.spec.description.slice(0, 60)}` : ""}
                      </div>
                    </td>
                    <td>
                      {m?.last ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <StatusPill state={m.last.state} />
                          <span className="muted small" style={{ whiteSpace: "nowrap" }}>{timeAgo(m.last.created_at)}</span>
                        </span>
                      ) : (
                        <span className="muted">never ran</span>
                      )}
                    </td>
                    <td>{m ? <HistoryBars history={m.history} /> : <span className="muted">—</span>}</td>
                    <td className="num">
                      {successPct === null ? <span className="muted">—</span> : <span style={{ color: successPct >= 90 ? "var(--good)" : successPct >= 60 ? "var(--warning)" : "var(--critical)", fontWeight: 600 }}>{successPct}%</span>}
                    </td>
                    <td className="num">{m?.avgMs != null ? formatMs(m.avgMs) : <span className="muted">—</span>}</td>
                    <td>{triggers.length ? triggers.map((t) => <span key={t} className="chip" style={{ marginRight: 6 }}>{t}</span>) : <span className="muted">manual</span>}</td>
                    <td><span style={{ display: "inline-flex", gap: 6 }}>{runtimes.map((r) => <RuntimeBadge key={r} runtime={r} />)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
