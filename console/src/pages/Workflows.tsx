import { Clock, Database, GitBranch, HandTap, MagnifyingGlass, Plus } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, formatDuration, formatMs, timeAgo, useEvents } from "../api";
import { useCrumbs } from "../App";
import { MiniDag } from "../components/DagGraph";
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

export type TriggerKind = "manual" | "schedule" | "ingest";

/** "45s", "30m", "2h", "1d", "1h 30m" — for schedule chips. */
export function formatSchedule(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const parts: string[] = [];
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  return parts.slice(0, 2).join(" ");
}

export function triggerKind(spec: WorkflowSpec): TriggerKind {
  if (spec.triggers.every_secs) return "schedule";
  if (spec.triggers.on_ingest) return "ingest";
  return "manual";
}

/** One chip per trigger ("every 60s", "on ingest events"), or "manual". */
export function TriggerChips({ spec }: { spec: WorkflowSpec }) {
  const chips: ReactNode[] = [];
  if (spec.triggers.every_secs) {
    chips.push(
      <span key="s" className="chip" title="Scheduled">
        <Clock size={11} /> every {formatSchedule(spec.triggers.every_secs)}
      </span>,
    );
  }
  if (spec.triggers.on_ingest) {
    chips.push(
      <span key="i" className="chip" title="Runs when records land in this dataset">
        <Database size={11} /> on ingest <span className="mono">{spec.triggers.on_ingest}</span>
      </span>,
    );
  }
  if (!chips.length) {
    chips.push(
      <span key="m" className="chip" title="Only runs when triggered by hand or via the API">
        <HandTap size={11} /> manual
      </span>,
    );
  }
  return <>{chips}</>;
}

function WorkflowCard({ wf, m, onOpen }: { wf: Workflow; m?: WorkflowMetrics; onOpen: () => void }) {
  const runtimes = [...new Set(wf.spec.tasks.map((t) => t.runtime))];
  const successPct = m && m.completed + m.failed > 0 ? Math.round((m.completed / (m.completed + m.failed)) * 100) : null;
  return (
    <div
      className="wf-card"
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
    >
      <div className="wf-card-head">
        <div style={{ minWidth: 0 }}>
          <div className="primary truncate" title={wf.spec.name}>{wf.spec.name}</div>
          <div className="muted small truncate" title={wf.spec.description ?? undefined}>
            {wf.spec.tasks.length} task{wf.spec.tasks.length === 1 ? "" : "s"}
            {wf.spec.description ? ` · ${wf.spec.description}` : ""}
          </div>
        </div>
        <span style={{ display: "inline-flex", gap: 6, flexShrink: 0 }}>{runtimes.map((r) => <RuntimeBadge key={r} runtime={r} />)}</span>
      </div>
      <div className="wf-dag">
        <MiniDag tasks={wf.spec.tasks} />
      </div>
      <div className="wf-card-foot">
        <div className="wf-last">
          {m?.last ? (
            <>
              <StatusPill state={m.last.state} />
              <span className="num">{formatDuration(m.last.started_at, m.last.finished_at)}</span>
              <span className="muted">{timeAgo(m.last.created_at)}</span>
            </>
          ) : (
            <span className="muted">never ran</span>
          )}
        </div>
        {m && m.history.length > 1 && <HistoryBars history={m.history} />}
      </div>
      <div className="wf-card-foot">
        <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
          <TriggerChips spec={wf.spec} />
        </span>
        <span className="muted small num" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
          {m && m.total > 0 ? (
            <>
              {successPct !== null && (
                <span style={{ color: successPct >= 90 ? "var(--good)" : successPct >= 60 ? "var(--warning)" : "var(--critical)", fontWeight: 600 }}>{successPct}%</span>
              )}
              {successPct !== null && " · "}
              {m.total} run{m.total === 1 ? "" : "s"}
              {m.avgMs != null && ` · avg ${formatMs(m.avgMs)}`}
            </>
          ) : (
            "no runs"
          )}
        </span>
      </div>
    </div>
  );
}

export default function Workflows() {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | TriggerKind>("all");
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

  const filtered = useMemo(() => {
    if (!workflows) return [];
    const needle = q.trim().toLowerCase();
    return workflows.filter((wf) => {
      if (kind !== "all" && triggerKind(wf.spec) !== kind) return false;
      if (!needle) return true;
      const hay = [wf.spec.name, wf.spec.description ?? "", ...wf.spec.tasks.flatMap((t) => [t.id, t.name ?? "", t.runtime])].join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }, [workflows, q, kind]);

  const counts = useMemo(() => {
    const c = { all: workflows?.length ?? 0, manual: 0, schedule: 0, ingest: 0 };
    for (const wf of workflows ?? []) c[triggerKind(wf.spec)]++;
    return c;
  }, [workflows]);

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

      {workflows !== null && workflows.length > 0 && (
        <div className="toolbar" style={{ marginBottom: 14 }}>
          <div className="seg">
            {(["all", "manual", "schedule", "ingest"] as const).map((k) => (
              <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                {k === "schedule" ? "scheduled" : k === "ingest" ? "on ingest" : k}
                {counts[k] ? <span className="dim">{counts[k]}</span> : null}
              </button>
            ))}
          </div>
          <span className="grow" />
          <span className="filter-input">
            <MagnifyingGlass size={14} />
            <input type="search" placeholder="Search name, description, task id" value={q} onChange={(e) => setQ(e.target.value)} />
          </span>
        </div>
      )}

      {workflows === null ? (
        <div className="card"><div style={{ padding: 16 }}><div className="skeleton" style={{ height: 14 }} /></div></div>
      ) : workflows.length === 0 ? (
        <div className="card">
          <Empty icon={<GitBranch size={20} />} title="No workflows yet" hint="Create one here, or deploy from the Python / TypeScript SDK." action={<button className="btn primary sm" onClick={() => setParams({ new: "1" })}>New workflow</button>} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="card"><Empty title="No workflows match" hint="Adjust the search or trigger filter." /></div>
      ) : (
        <div className="wf-grid">
          {filtered.map((wf) => (
            <WorkflowCard key={wf.id} wf={wf} m={metricsByWorkflow.get(wf.id)} onOpen={() => navigate(`/workflows/${wf.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
}
