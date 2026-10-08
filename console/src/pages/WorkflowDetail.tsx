import { PencilSimple, Play, Trash } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, formatDuration, formatMs, timeAgo, useEvents } from "../api";
import { useCrumbs } from "../App";
import Chart from "../components/charts/Chart";
import DagGraph from "../components/DagGraph";
import JsonView from "../components/JsonView";
import TaskPanel, { Facts } from "../components/TaskPanel";
import { Banner, Empty, RuntimeBadge, StatusPill, Tile, useConfirm, useToast } from "../components/ui";
import WorkflowBuilder from "../components/WorkflowBuilder";
import type { Run, RunState, TaskRun, Workflow, WorkflowSpec } from "../types";
import { computeMetrics, formatSchedule, HistoryBars, TriggerChips } from "./Workflows";

const STATE_COLORS = { completed: "var(--good)", failed: "var(--critical)", running: "var(--running)", cancelled: "var(--ink-4)", pending: "var(--ink-4)" };

function RunningProgress({ run, onClick }: { run: Run; onClick: () => void }) {
  const [tasks, setTasks] = useState<TaskRun[]>([]);
  const refresh = useCallback(() => {
    api.get<{ run: Run; tasks: TaskRun[] }>(`/api/runs/${run.id}`).then((d) => setTasks(d.tasks)).catch(() => {});
  }, [run.id]);
  useEffect(refresh, [refresh]);
  useEvents((ev) => {
    if (ev.type === "task_updated") {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.task_id === ev.task.task_id);
        if (idx === -1) return [...prev, ev.task];
        const next = [...prev];
        next[idx] = ev.task;
        return next;
      });
    }
  }, run.id);
  const done = tasks.filter((t) => t.state === "completed").length;
  const total = Math.max(1, tasks.length);
  const runningTask = tasks.find((t) => t.state === "running");
  return (
    <div className="running-banner" onClick={onClick}>
      <StatusPill state="running" />
      <div className="progress-track"><div className="progress-fill" style={{ width: `${(done / total) * 100}%` }} /></div>
      <span style={{ color: "var(--ink)", fontWeight: 600, whiteSpace: "nowrap" }}>{done}/{total} tasks</span>
      {runningTask && <span className="muted mono small" style={{ whiteSpace: "nowrap" }}>▸ {runningTask.task_id}</span>}
    </div>
  );
}

function isEmptyParams(p: unknown): boolean {
  return p === null || p === undefined || (typeof p === "object" && !Array.isArray(p) && Object.keys(p as object).length === 0);
}

export default function WorkflowDetail() {
  const { id } = useParams<{ id: string }>();
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [paramsDraft, setParamsDraft] = useState("");
  // The run whose task states colour the graph and feed the task panel.
  const [viewRunId, setViewRunId] = useState<string | null>(null);
  const [viewTasks, setViewTasks] = useState<TaskRun[]>([]);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  useCrumbs([{ label: "Workflows", to: "/workflows" }, { label: workflow?.spec.name ?? "…" }]);

  const refresh = useCallback(() => {
    if (!id) return;
    api.get<Workflow>(`/api/workflows/${id}`).then(setWorkflow).catch((e) => setError(e.message));
    api.get<Run[]>(`/api/runs?workflow_id=${id}&limit=100`).then(setRuns).catch(() => {});
  }, [id]);
  useEffect(refresh, [refresh]);
  useEvents((ev) => {
    if (ev.type === "run_updated" && ev.run.workflow_id === id) {
      setRuns((prev) => {
        const idx = prev.findIndex((r) => r.id === ev.run.id);
        if (idx === -1) return [ev.run, ...prev];
        const next = [...prev];
        next[idx] = ev.run;
        return next;
      });
    }
    if (ev.type === "task_updated" && ev.task.run_id === viewRunId) {
      setViewTasks((prev) => {
        const idx = prev.findIndex((t) => t.task_id === ev.task.task_id);
        if (idx === -1) return [...prev, ev.task];
        const next = [...prev];
        next[idx] = ev.task;
        return next;
      });
    }
  });

  // Default the graph to the latest run once history arrives.
  useEffect(() => {
    if (viewRunId === null && runs.length) setViewRunId(runs[0].id);
  }, [runs, viewRunId]);
  useEffect(() => {
    if (!viewRunId) {
      setViewTasks([]);
      return;
    }
    let cancelled = false;
    api
      .get<{ run: Run; tasks: TaskRun[] }>(`/api/runs/${viewRunId}`)
      .then((d) => {
        if (!cancelled) setViewTasks(d.tasks);
      })
      .catch(() => {
        if (!cancelled) setViewTasks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [viewRunId]);

  const metrics = useMemo(() => computeMetrics(runs), [runs]);
  const successPct = metrics.completed + metrics.failed > 0 ? Math.round((metrics.completed / (metrics.completed + metrics.failed)) * 100) : null;
  const activeRuns = runs.filter((r) => r.state === "running" || r.state === "pending");
  const trend = useMemo(
    () =>
      [...runs]
        .reverse()
        .slice(-40)
        .map((r, i) => ({ run: `#${i + 1}`, ms: r.started_at && r.finished_at ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime() : 0, state: r.state })),
    [runs],
  );
  const viewRun = runs.find((r) => r.id === viewRunId) ?? null;
  const states = useMemo(() => Object.fromEntries(viewTasks.map((t) => [t.task_id, t.state])) as Record<string, RunState>, [viewTasks]);
  const selectedSpec = workflow?.spec.tasks.find((t) => t.id === selectedTask) ?? null;
  const selectedRun = selectedTask ? viewTasks.find((t) => t.task_id === selectedTask) ?? null : null;
  const closePanel = useCallback(() => setSelectedTask(null), []);

  const save = async (spec: WorkflowSpec) => {
    const wf = await api.put<Workflow>(`/api/workflows/${id}`, spec);
    setWorkflow(wf);
    setEditing(false);
    toast("Workflow saved");
  };

  const trigger = async () => {
    setError(null);
    try {
      let params: unknown = {};
      if (paramsDraft.trim()) params = JSON.parse(paramsDraft);
      const run = await api.post<Run>(`/api/workflows/${id}/trigger`, { params });
      navigate(`/runs/${run.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!(await confirm({ title: `Delete “${workflow?.spec.name}”?`, body: "Run history stays; the workflow and its triggers are removed.", confirmLabel: "Delete workflow" }))) return;
    await api.delete(`/api/workflows/${id}`);
    navigate("/workflows");
  };

  if (!workflow) return <div className="content">{error ? <Banner kind="error">{error}</Banner> : <div className="skeleton" style={{ height: 28, width: 300 }} />}</div>;

  const spec = workflow.spec;
  return (
    <div className="content">
      {confirmDialog}
      {selectedSpec && <TaskPanel task={selectedSpec} run={selectedRun} runLabel={viewRun ? `run ${viewRun.id.slice(0, 8)}` : undefined} onClose={closePanel} />}
      <div className="page-head">
        <div>
          <h1>
            {spec.name}
            {metrics.last && <StatusPill state={metrics.last.state} />}
          </h1>
          <p>
            {spec.description || "No description."} · {[...new Set(spec.tasks.map((t) => t.runtime))].map((r) => <RuntimeBadge key={r} runtime={r} />)}
          </p>
        </div>
        <div className="actions">
          <button className="btn danger" onClick={remove}><Trash size={14} /> Delete</button>
          <button className="btn" onClick={() => setEditing((v) => !v)}><PencilSimple size={14} /> {editing ? "Close editor" : "Edit"}</button>
          <input type="text" className="mono" placeholder='params override {"n": 5}' value={paramsDraft} onChange={(e) => setParamsDraft(e.target.value)} style={{ width: 200 }} />
          <button className="btn primary" onClick={trigger}><Play size={14} weight="fill" /> Trigger run</button>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {editing && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h2>Edit workflow</h2></div>
          <div className="card-body"><WorkflowBuilder initial={spec} workflowId={id} submitLabel="Save changes" onSubmit={save} /></div>
        </div>
      )}

      {activeRuns.map((r) => <RunningProgress key={r.id} run={r} onClick={() => navigate(`/runs/${r.id}`)} />)}

      <div className="tiles">
        <Tile label="Total runs" value={metrics.total} />
        <Tile label="Success rate" value={successPct === null ? "—" : `${successPct}%`} sub={`${metrics.completed} ok · ${metrics.failed} failed`} tone={successPct === null ? undefined : successPct >= 80 ? "good" : "bad"} />
        <Tile label="Avg duration" value={metrics.avgMs != null ? formatMs(metrics.avgMs) : "—"} tone="accent" />
        <Tile label="Last run" value={metrics.last ? timeAgo(metrics.last.created_at) : "never"} sub={metrics.last ? `trigger: ${metrics.last.trigger}` : undefined} />
        <Tile label="Schedule" value={spec.triggers.every_secs ? `every ${formatSchedule(spec.triggers.every_secs)}` : spec.triggers.on_ingest ? "on ingest" : "manual"} sub={spec.triggers.on_ingest ? `dataset ${spec.triggers.on_ingest}` : `${spec.max_parallel_tasks} parallel max`} />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>
            Task graph <span className="sub">{spec.tasks.length} tasks · click a task for its code and results</span>
          </h2>
          <label className="small muted" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            states from
            <select className="inline" value={viewRunId ?? ""} onChange={(e) => setViewRunId(e.target.value || null)} disabled={runs.length === 0}>
              {runs.length === 0 && <option value="">no runs yet</option>}
              {runs.slice(0, 25).map((r, i) => (
                <option key={r.id} value={r.id}>
                  {i === 0 ? "latest · " : ""}{r.id.slice(0, 8)} · {r.state} · {timeAgo(r.created_at)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="card-body">
          <DagGraph tasks={spec.tasks} states={viewRunId ? states : undefined} selected={selectedTask} onSelect={(tid) => setSelectedTask((cur) => (cur === tid ? null : tid))} />
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="card" style={{ marginTop: 0 }}>
          <div className="card-head">
            <h2>Duration trend <span className="sub">last {trend.length} runs</span></h2>
            <HistoryBars history={metrics.history} />
          </div>
          <div className="card-body" style={{ paddingBottom: 6 }}>
            {trend.length ? <Chart rows={trend} spec={{ mark: "bar", x: "run", y: ["ms"], color: "state", agg: "sum" }} height={170} colors={STATE_COLORS} /> : <Empty title="Never run" />}
          </div>
        </div>
        <div className="card" style={{ marginTop: 0 }}>
          <div className="card-head"><h2>Configuration</h2></div>
          <div className="card-body" style={{ display: "grid", gap: 14 }}>
            <Facts
              items={[
                ["Triggers", <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}><TriggerChips spec={spec} /></span>],
                ["Max parallel", `${spec.max_parallel_tasks} task${spec.max_parallel_tasks === 1 ? "" : "s"}`],
                ["Updated", `${timeAgo(workflow.updated_at)} · created ${new Date(workflow.created_at).toLocaleDateString()}`],
              ]}
            />
            <div>
              <h4 className="facts-title">
                Params <span className="muted">· defaults every run starts from (task params overlay, trigger overrides)</span>
              </h4>
              {isEmptyParams(spec.params) ? <p className="muted small" style={{ margin: 0 }}>None.</p> : <JsonView value={spec.params} />}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Runs</h2></div>
        {runs.length === 0 ? (
          <Empty title="Never run" hint="Trigger it to see run history." />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>State</th>
                <th>Trigger</th>
                <th className="num">Duration</th>
                <th className="num">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.slice(0, 25).map((r) => (
                <tr key={r.id} className="rowlink" onClick={() => navigate(`/runs/${r.id}`)}>
                  <td className="mono muted">{r.id.slice(0, 8)}</td>
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
