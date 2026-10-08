import { ArrowSquareOut, CaretRight, Code, XCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, formatDuration, useEvents } from "../api";
import { useCrumbs } from "../App";
import DagGraph from "../components/DagGraph";
import LogStream, { type LogLine } from "../components/LogStream";
import TaskPanel, { TaskRunBody } from "../components/TaskPanel";
import { Banner, RuntimeBadge, StatusPill, Tile, useConfirm, useToast } from "../components/ui";
import type { Run, RunState, TaskRun, TaskSpec, Workflow } from "../types";

const STATE_FILL: Record<string, string> = {
  completed: "var(--good)",
  failed: "var(--critical)",
  running: "var(--running)",
  cancelled: "var(--ink-4)",
  pending: "var(--surface-4)",
};

function TaskTimeline({ run, tasks }: { run: Run; tasks: TaskRun[] }) {
  const started = tasks.filter((t) => t.started_at).sort((a, b) => (a.started_at! < b.started_at! ? -1 : 1));
  if (started.length === 0) return <p className="muted small" style={{ margin: 0 }}>No task has started yet.</p>;
  const t0 = new Date(run.started_at ?? started[0].started_at!).getTime();
  const tEnd = Math.max(...started.map((t) => new Date(t.finished_at ?? new Date().toISOString()).getTime()), t0 + 1);
  const span = tEnd - t0;
  const W = 760;
  const LABEL = 150;
  const ROW = 26;
  const H = started.length * ROW + 24;
  const ticks = 4;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" style={{ width: "100%", height: "auto" }} role="img" aria-label="Task timeline">
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const x = LABEL + (i / ticks) * (W - LABEL - 60);
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={0} y2={H - 20} stroke="var(--grid)" />
            <text x={x} y={H - 6} textAnchor="middle" style={{ fill: "var(--ink-3)", fontSize: 10.5 }}>{Math.round((i / ticks) * span)}ms</text>
          </g>
        );
      })}
      {started.map((t, i) => {
        const s = new Date(t.started_at!).getTime();
        const e = new Date(t.finished_at ?? new Date().toISOString()).getTime();
        const x = LABEL + ((s - t0) / span) * (W - LABEL - 60);
        const w = Math.max(3, ((e - s) / span) * (W - LABEL - 60));
        const y = i * ROW + 6;
        return (
          <g key={t.task_id}>
            <text x={LABEL - 10} y={y + 12} textAnchor="end" className="gantt-label">
              <title>{t.task_id}</title>
              {t.task_id.slice(0, 18)}
            </text>
            <rect x={x} y={y} width={w} height={16} rx="4" fill={STATE_FILL[t.state] ?? "var(--surface-4)"}>
              <title>{`${t.task_id}: ${t.state}, ${e - s}ms`}</title>
            </rect>
            <text x={x + w + 6} y={y + 12} className="gantt-ms">{e - s}ms</text>
          </g>
        );
      })}
    </svg>
  );
}

function summary(t: TaskRun): string {
  if (t.error) return t.error.split("\n")[0];
  const r = t.result;
  if (r === null || r === undefined) return "";
  if (Array.isArray(r)) {
    const first = r[0];
    const cols = first && typeof first === "object" && !Array.isArray(first) ? Object.keys(first as object).length : null;
    return `${r.length.toLocaleString()} row${r.length === 1 ? "" : "s"}${cols !== null ? ` × ${cols} col${cols === 1 ? "" : "s"}` : ""}`;
  }
  if (typeof r === "object") return `{${Object.keys(r as object).slice(0, 6).join(", ")}${Object.keys(r as object).length > 6 ? ", …" : ""}}`;
  return JSON.stringify(r);
}

function TaskRow({ task, spec, open, onToggle, onInspect }: { task: TaskRun; spec?: TaskSpec; open: boolean; onToggle: () => void; onInspect?: () => void }) {
  return (
    <div className={`task-item${open ? " open" : ""}`}>
      <div
        className="task-row"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="tname">
          <CaretRight size={12} weight="bold" className="caret" />
          <span className="truncate" title={task.name}>{task.name}</span>
          {spec && <RuntimeBadge runtime={spec.runtime} />}
        </span>
        <StatusPill state={task.state} />
        <span className="muted num">{formatDuration(task.started_at, task.finished_at)}</span>
        <span className="muted mono truncate" style={{ color: task.error ? "var(--critical)" : undefined }}>
          {summary(task)}
        </span>
        <span className="muted small num" style={{ whiteSpace: "nowrap" }}>
          {task.attempts > 1 ? `${task.attempts} attempts` : ""}
        </span>
      </div>
      {open && (
        <div className="task-detail-body">
          <TaskRunBody run={task} filename={task.task_id} />
          {onInspect && (
            <div>
              <button
                className="btn sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onInspect();
                }}
              >
                <Code size={13} /> Task code &amp; spec
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [tasks, setTasks] = useState<TaskRun[]>([]);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [liveLogs, setLiveLogs] = useState<LogLine[]>([]);
  const [openTasks, setOpenTasks] = useState<Set<string>>(new Set());
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const toast = useToast();
  useCrumbs([{ label: "Runs", to: "/runs" }, { label: run ? `${run.workflow_name} · ${run.id.slice(0, 8)}` : "…" }]);

  const refresh = useCallback(() => {
    if (!id) return;
    api
      .get<{ run: Run; tasks: TaskRun[] }>(`/api/runs/${id}`)
      .then(({ run, tasks }) => {
        setRun(run);
        setTasks(tasks);
        // Failed tasks start expanded — that's what you came to see.
        setOpenTasks(new Set(tasks.filter((t) => t.state === "failed").map((t) => t.task_id)));
        api.get<Workflow>(`/api/workflows/${run.workflow_id}`).then(setWorkflow).catch(() => {});
      })
      .catch(() => {});
  }, [id]);
  useEffect(refresh, [refresh]);

  useEvents((ev) => {
    if (ev.type === "run_updated") setRun(ev.run);
    if (ev.type === "task_updated") {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.task_id === ev.task.task_id);
        if (idx === -1) return [...prev, ev.task];
        const next = [...prev];
        next[idx] = ev.task;
        return next;
      });
      if (ev.task.state === "failed") setOpenTasks((prev) => new Set(prev).add(ev.task.task_id));
    }
    if (ev.type === "log") setLiveLogs((prev) => [...prev, { ts: ev.ts, tag: ev.task_id, line: ev.line }].slice(-800));
  }, id);

  const cancel = async () => {
    if (!run) return;
    if (!(await confirm({ title: "Cancel this run?", body: "Running tasks are killed and the remaining tasks are marked cancelled.", confirmLabel: "Cancel run" }))) return;
    try {
      await api.post(`/api/runs/${run.id}/cancel`);
      toast("Run cancelled");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const closePanel = useCallback(() => setSelectedTask(null), []);
  const specById = useMemo(() => new Map((workflow?.spec.tasks ?? []).map((t) => [t.id, t])), [workflow]);

  if (!run) return <div className="content"><div className="skeleton" style={{ height: 28, width: 300 }} /></div>;

  const states: Record<string, RunState> = Object.fromEntries(tasks.map((t) => [t.task_id, t.state]));
  const storedLogs: LogLine[] = tasks.flatMap((t) => t.logs.map((line) => ({ ts: t.started_at ?? run.created_at, tag: t.task_id, line })));
  const logs = liveLogs.length ? liveLogs : storedLogs;
  const done = tasks.filter((t) => t.state === "completed").length;
  const isActive = run.state === "running" || run.state === "pending";
  const selectedSpec = selectedTask ? specById.get(selectedTask) ?? null : null;
  const selectedRun = selectedTask ? tasks.find((t) => t.task_id === selectedTask) ?? null : null;
  const toggleTask = (tid: string) =>
    setOpenTasks((prev) => {
      const next = new Set(prev);
      if (next.has(tid)) next.delete(tid);
      else next.add(tid);
      return next;
    });

  return (
    <div className="content">
      {confirmDialog}
      {selectedSpec && <TaskPanel task={selectedSpec} run={selectedRun} runLabel={`run ${run.id.slice(0, 8)}`} onClose={closePanel} />}
      <div className="page-head">
        <div>
          <h1>
            {run.workflow_name} <StatusPill state={run.state} />
          </h1>
          <p>
            <span className="mono">{run.id}</span> · trigger <span className="chip">{run.trigger}</span> · started {run.started_at ? new Date(run.started_at).toLocaleString() : "not yet"}
          </p>
        </div>
        <div className="actions">
          <Link className="btn" to={`/workflows/${run.workflow_id}`}><ArrowSquareOut size={14} /> Workflow</Link>
          {isActive && <button className="btn danger" onClick={cancel}><XCircle size={14} /> Cancel run</button>}
        </div>
      </div>

      {run.error && <Banner kind="error">{run.error}</Banner>}

      <div className="tiles">
        <Tile label="Duration" value={formatDuration(run.started_at, run.finished_at)} sub={run.finished_at ? `finished ${new Date(run.finished_at).toLocaleTimeString()}` : isActive ? "in progress" : undefined} />
        <Tile label="Tasks" value={`${done} / ${tasks.length}`} sub={`${tasks.filter((t) => t.state === "failed").length} failed · ${tasks.filter((t) => t.state === "cancelled").length} cancelled`} tone={run.state === "completed" ? "good" : run.state === "failed" ? "bad" : undefined} />
        <Tile label="Attempts" value={tasks.reduce((a, t) => a + t.attempts, 0)} sub={`${tasks.filter((t) => t.attempts > 1).length} retried`} />
        <Tile label="Parameters" value={<span style={{ fontSize: 13, fontFamily: "var(--mono)", fontWeight: 500 }} className="truncate">{JSON.stringify(run.params ?? {}).slice(0, 60) || "{}"}</span>} />
      </div>

      {isActive && (
        <div className="running-banner" style={{ cursor: "default" }}>
          <StatusPill state="running" />
          <div className="progress-track"><div className="progress-fill" style={{ width: `${(done / Math.max(1, tasks.length)) * 100}%` }} /></div>
          <span style={{ color: "var(--ink)", fontWeight: 600, whiteSpace: "nowrap" }}>{done}/{tasks.length} tasks</span>
        </div>
      )}

      {workflow && (
        <div className="card">
          <div className="card-head">
            <h2>
              Task graph <span className="sub">click a task for its code and this run's result</span>
            </h2>
          </div>
          <div className="card-body">
            <DagGraph tasks={workflow.spec.tasks} states={states} selected={selectedTask} onSelect={(tid) => setSelectedTask((cur) => (cur === tid ? null : tid))} />
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h2>Timeline</h2></div>
        <div className="card-body"><TaskTimeline run={run} tasks={tasks} /></div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>
            Tasks <span className="sub">{tasks.length} · click a row for its result, logs and timings</span>
          </h2>
          {tasks.length > 0 && (
            <button className="btn sm ghost" onClick={() => setOpenTasks(openTasks.size === tasks.length ? new Set() : new Set(tasks.map((t) => t.task_id)))}>
              {openTasks.size === tasks.length ? "Collapse all" : "Expand all"}
            </button>
          )}
        </div>
        {tasks.length === 0 && <p className="muted small" style={{ margin: 0, padding: 16 }}>No tasks have been scheduled yet.</p>}
        {tasks.map((t) => (
          <TaskRow
            key={t.task_id}
            task={t}
            spec={specById.get(t.task_id)}
            open={openTasks.has(t.task_id)}
            onToggle={() => toggleTask(t.task_id)}
            onInspect={specById.has(t.task_id) ? () => setSelectedTask(t.task_id) : undefined}
          />
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Logs</h2>
          {run.state === "running" && <span className="sub">streaming live</span>}
        </div>
        <LogStream lines={logs} done={!isActive} />
      </div>
    </div>
  );
}
