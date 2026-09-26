import { MagnifyingGlass, XCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, formatDuration, timeAgo, useEvents } from "../api";
import { useCrumbs } from "../App";
import { Empty, StatusPill, useToast } from "../components/ui";
import type { Run, RunState } from "../types";

const STATES: Array<RunState | "all"> = ["all", "running", "completed", "failed", "cancelled"];

export default function Runs() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [state, setState] = useState<RunState | "all">("all");
  const [q, setQ] = useState("");
  const [workflow, setWorkflow] = useState("");
  const navigate = useNavigate();
  const toast = useToast();
  useCrumbs([{ label: "Runs" }]);

  const refresh = useCallback(() => {
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

  const workflows = useMemo(() => [...new Set(runs.map((r) => r.workflow_name))].sort(), [runs]);
  const filtered = useMemo(
    () =>
      runs.filter(
        (r) =>
          (state === "all" || r.state === state || (state === "running" && r.state === "pending")) &&
          (!workflow || r.workflow_name === workflow) &&
          (!q || `${r.id} ${r.workflow_name} ${r.trigger} ${r.error ?? ""}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [runs, state, workflow, q],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of runs) c[r.state] = (c[r.state] ?? 0) + 1;
    return c;
  }, [runs]);

  const cancel = async (r: Run, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.post(`/api/runs/${r.id}/cancel`);
      toast(`Cancelled ${r.workflow_name}`);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Runs</h1>
          <p>Every workflow execution, updating live over SSE.</p>
        </div>
      </div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <div className="seg">
          {STATES.map((s) => (
            <button key={s} className={state === s ? "on" : ""} onClick={() => setState(s)}>
              {s}
              {s !== "all" && counts[s] ? <span className="dim">{counts[s]}</span> : null}
            </button>
          ))}
        </div>
        <select className="inline" value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
          <option value="">all workflows</option>
          {workflows.map((w) => (
            <option key={w} value={w}>{w}</option>
          ))}
        </select>
        <span className="grow" />
        <span className="filter-input">
          <MagnifyingGlass size={14} />
          <input type="search" placeholder="Search id, trigger, error" value={q} onChange={(e) => setQ(e.target.value)} />
        </span>
      </div>
      <div className="card">
        {filtered.length === 0 ? (
          <Empty title={runs.length ? "No runs match" : "No runs yet"} hint={runs.length ? "Adjust the filters." : "Trigger a workflow to see it here."} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Workflow</th>
                <th>State</th>
                <th>Trigger</th>
                <th className="num">Duration</th>
                <th className="num">Started</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((r) => (
                <tr key={r.id} className="rowlink" onClick={() => navigate(`/runs/${r.id}`)}>
                  <td className="mono muted">{r.id.slice(0, 8)}</td>
                  <td className="primary">
                    {r.workflow_name}
                    {r.error && <div className="small muted truncate" style={{ maxWidth: 360, color: "var(--critical)" }}>{r.error}</div>}
                  </td>
                  <td><StatusPill state={r.state} /></td>
                  <td><span className="chip">{r.trigger}</span></td>
                  <td className="num">{formatDuration(r.started_at, r.finished_at)}</td>
                  <td className="num muted">{timeAgo(r.created_at)}</td>
                  <td className="num">
                    {(r.state === "running" || r.state === "pending") && (
                      <button className="btn sm ghost danger" onClick={(e) => cancel(r, e)} title="Cancel run"><XCircle size={13} /> Cancel</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {filtered.length > 200 && <div className="dg-foot">Showing 200 of {filtered.length} runs. Narrow the filter to see more.</div>}
      </div>
    </div>
  );
}
