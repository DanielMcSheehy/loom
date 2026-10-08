// Side drawer for one task of a workflow: its spec (code, params, retries,
// timeout, dependencies) and, when a run is in view, that run's result, logs,
// timings and error. Shared by WorkflowDetail (click a DAG node) and RunDetail.
import { X } from "@phosphor-icons/react";
import { useEffect, type ReactNode } from "react";
import { formatDuration } from "../api";
import { CodeBlock, type CodeLanguage } from "./CodeBlock";
import JsonView from "./JsonView";
import ResultView from "./ResultView";
import { Banner, RuntimeBadge, StatusPill } from "./ui";
import type { TaskRun, TaskSpec } from "../types";

export function codeLanguage(runtime: TaskSpec["runtime"]): CodeLanguage {
  return runtime === "python" ? "python" : runtime === "typescript" ? "typescript" : "javascript";
}

function isEmptyParams(p: unknown): boolean {
  return p === null || p === undefined || (typeof p === "object" && !Array.isArray(p) && Object.keys(p as object).length === 0);
}

/** `key: value` rows for the spec / timing summaries. */
export function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="facts">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Everything a run recorded for one task: timings, attempts, error, result, logs. */
export function TaskRunBody({ run, filename }: { run: TaskRun; filename: string }) {
  const hasResult = run.result !== null && run.result !== undefined;
  const errorLines = run.error ? run.error.split("\n") : [];
  const headline = errorLines[0];
  const trace = errorLines.length > 1 ? errorLines.slice(1).join("\n") : null;
  return (
    <div className="task-run-body">
      <Facts
        items={[
          ["State", <StatusPill state={run.state} />],
          ["Duration", formatDuration(run.started_at, run.finished_at)],
          ["Started", run.started_at ? new Date(run.started_at).toLocaleTimeString() : "—"],
          ["Finished", run.finished_at ? new Date(run.finished_at).toLocaleTimeString() : run.started_at ? "in progress" : "—"],
          ["Attempts", run.attempts],
        ]}
      />
      {run.error && (
        <div>
          <Banner kind="error">{headline}</Banner>
          {trace && <pre className="result-json trace">{trace}</pre>}
        </div>
      )}
      {hasResult && (
        <section>
          <h4>Result</h4>
          <ResultView value={run.result} filename={filename} />
        </section>
      )}
      {!hasResult && !run.error && run.state === "completed" && <p className="muted small" style={{ margin: 0 }}>The task returned nothing.</p>}
      {run.logs.length > 0 && (
        <section>
          <h4>
            Logs <span className="muted">· {run.logs.length} line{run.logs.length === 1 ? "" : "s"}</span>
          </h4>
          <pre className="result-json logs">{run.logs.join("\n")}</pre>
        </section>
      )}
    </div>
  );
}

export default function TaskPanel({
  task,
  run,
  runLabel,
  onClose,
}: {
  task: TaskSpec;
  /** This task's record in the run being viewed, if any. */
  run?: TaskRun | null;
  /** Where `run` comes from ("run 3f2a9c1e"), shown as the result section's subtitle. */
  runLabel?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <aside className="drawer" role="dialog" aria-label={`Task ${task.name ?? task.id}`}>
      <div className="drawer-head">
        <div style={{ minWidth: 0 }}>
          <div className="drawer-title">
            {task.name ?? task.id}
            {run && <StatusPill state={run.state} />}
          </div>
          <div className="muted small" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 3 }}>
            <span className="mono">{task.id}</span>
            <RuntimeBadge runtime={task.runtime} full />
          </div>
        </div>
        <button className="btn icon sm ghost" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <X size={14} />
        </button>
      </div>
      <div className="drawer-body">
        <section>
          <h4>Spec</h4>
          <Facts
            items={[
              ["Runtime", <RuntimeBadge runtime={task.runtime} full />],
              ["Timeout", `${task.timeout_secs}s`],
              ["Retries", task.retries],
              [
                "Depends on",
                task.depends_on.length ? (
                  <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                    {task.depends_on.map((d) => (
                      <span key={d} className="chip mono">{d}</span>
                    ))}
                  </span>
                ) : (
                  <span className="muted">none (root task)</span>
                ),
              ],
            ]}
          />
        </section>
        <section>
          <h4>
            Task params <span className="muted">· overlaid on the run params</span>
          </h4>
          {isEmptyParams(task.params) ? <p className="muted small" style={{ margin: 0 }}>None — the handler receives the run params as-is.</p> : <JsonView value={task.params} />}
        </section>
        <section>
          <h4>Code</h4>
          <CodeBlock code={task.code} language={codeLanguage(task.runtime)} className="drawer-code" />
        </section>
        <section>
          <h4>
            Run result {runLabel && <span className="muted">· {runLabel}</span>}
          </h4>
          {run ? <TaskRunBody run={run} filename={task.id} /> : <p className="muted small" style={{ margin: 0 }}>{runLabel ? "This task was not part of that run." : "No run selected — trigger the workflow or pick a run above."}</p>}
        </section>
      </div>
    </aside>
  );
}
