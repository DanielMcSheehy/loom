//! The orchestrator drives one workflow run to completion: it walks the DAG
//! in topological layers, executes each layer's tasks in parallel (bounded by
//! `max_parallel_tasks`), feeds upstream results into downstream tasks, and
//! broadcasts every state change and log line onto the event stream.
//!
//! Cancellation: every run registers a `CancellationToken` in
//! `AppState::cancellations` at launch. `cancel_run` (the API side) cancels
//! the token and marks the run `cancelled` synchronously; the background
//! task observes the token before each layer and while awaiting each task
//! (`tokio::select!`), abandons in-flight workers, and marks every
//! non-terminal task `cancelled`. Whoever removes the token from the registry
//! owns the run's terminal transition, so a terminal state is written
//! exactly once.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::Utc;
use loom_core::{topo_layers, LoomEvent, Run, RunState, TaskRun, TaskSpec, Workflow};
use loom_executor::{ExecError, ExecRequest};
use serde_json::{Map, Value};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use tracing::{error, info};
use uuid::Uuid;

use crate::state::SharedState;

/// Error recorded on runs and tasks stopped by `cancel_run`.
pub const CANCELLED_BY_USER: &str = "cancelled by user";

/// Create a pending run and its task-run rows, then hand it to the
/// background orchestrator. Returns the run immediately.
pub fn launch_run(
    state: SharedState,
    workflow: Workflow,
    params: Value,
    trigger: impl Into<String>,
) -> Result<Run, loom_store::StoreError> {
    let effective = merge_params(&workflow.spec.params, &params);
    let run = Run::new(&workflow, effective, trigger);
    state.store.put_run(&run)?;
    for task in &workflow.spec.tasks {
        state.store.put_task_run(&TaskRun::new(run.id, task))?;
    }
    // Registered before the run is announced so a cancel that races the
    // launch always finds a token.
    state
        .cancellations
        .lock()
        .insert(run.id, CancellationToken::new());
    state.emit(LoomEvent::run_updated(run.clone()));

    let run_for_bg = run.clone();
    tokio::spawn(async move {
        execute_run(state, workflow, run_for_bg).await;
    });
    Ok(run)
}

/// Result of a cancellation request.
#[derive(Debug)]
pub enum CancelOutcome {
    /// The run was pending/running and is now `cancelled`.
    Cancelled(Run),
    /// The run had already reached a terminal state; nothing changed.
    AlreadyTerminal(Run),
}

/// Cancel a run. Marks the run `cancelled` synchronously (store write +
/// event) and signals the background orchestrator, which stops waiting on
/// its workers and marks the outstanding tasks `cancelled`.
pub fn cancel_run(state: &SharedState, id: Uuid) -> Result<CancelOutcome, loom_store::StoreError> {
    let mut run = state.store.get_run(id)?;
    let mut map = state.cancellations.lock();
    match map.remove(&id) {
        Some(token) => {
            token.cancel();
            // Re-read under the lock: the orchestrator may have advanced the
            // run since the first fetch, but it can't finish it — the token
            // is ours now.
            run = state.store.get_run(id)?;
        }
        None if run.state.is_terminal() => return Ok(CancelOutcome::AlreadyTerminal(run)),
        // No token but non-terminal: an orphan (e.g. the server restarted
        // mid-run). Nobody else will finish it, so do it here — tasks too.
        None => {
            drop(map);
            cancel_outstanding_tasks(state, id);
            finish_cancelled(state, &mut run);
            return Ok(CancelOutcome::Cancelled(run));
        }
    }
    if !run.state.is_terminal() {
        finish_cancelled(state, &mut run);
    }
    Ok(CancelOutcome::Cancelled(run))
}

fn finish_cancelled(state: &SharedState, run: &mut Run) {
    info!(run = %run.id, "run cancelled by user");
    run.state = RunState::Cancelled;
    run.error = Some(CANCELLED_BY_USER.to_string());
    run.finished_at = Some(Utc::now());
    persist_run(state, run);
}

/// Mark every non-terminal task run of `run_id` as cancelled, from the store.
fn cancel_outstanding_tasks(state: &SharedState, run_id: Uuid) {
    for mut tr in state.store.list_task_runs(run_id).unwrap_or_default() {
        if !tr.state.is_terminal() {
            mark_task_cancelled(state, &mut tr);
        }
    }
}

fn mark_task_cancelled(state: &SharedState, tr: &mut TaskRun) {
    tr.state = RunState::Cancelled;
    tr.finished_at = Some(Utc::now());
    persist_task(state, tr);
}

async fn execute_run(state: SharedState, workflow: Workflow, mut run: Run) {
    // Take the token under the lock and persist `running` in the same
    // critical section, so a cancel can't slip between the two: either we
    // find the token and own the pending→running transition, or the run was
    // already cancelled and we only have tasks to clean up.
    let token = {
        let map = state.cancellations.lock();
        match map.get(&run.id) {
            Some(token) => {
                info!(run = %run.id, workflow = %workflow.spec.name, "run started");
                run.state = RunState::Running;
                run.started_at = Some(Utc::now());
                persist_run(&state, &run);
                token.clone()
            }
            None => {
                let token = CancellationToken::new();
                token.cancel();
                token
            }
        }
    };

    let tasks: HashMap<String, TaskSpec> = workflow
        .spec
        .tasks
        .iter()
        .map(|t| (t.id.clone(), t.clone()))
        .collect();
    let mut task_runs: HashMap<String, TaskRun> = state
        .store
        .list_task_runs(run.id)
        .unwrap_or_default()
        .into_iter()
        .map(|t| (t.task_id.clone(), t))
        .collect();

    let layers = topo_layers(&workflow.spec.tasks);
    let semaphore = Arc::new(Semaphore::new(workflow.spec.max_parallel_tasks.max(1)));
    let mut results: HashMap<String, Value> = HashMap::new();
    let mut failure: Option<String> = None;
    let mut cancelled = false;

    'layers: for layer in layers {
        if token.is_cancelled() {
            cancelled = true;
            break;
        }
        let mut handles = Vec::new();
        for task_id in layer {
            let spec = tasks[&task_id].clone();
            let mut task_run = task_runs
                .remove(&task_id)
                .unwrap_or_else(|| TaskRun::new(run.id, &spec));
            let inputs = Value::Object(
                spec.depends_on
                    .iter()
                    .filter_map(|d| results.get(d).map(|v| (d.clone(), v.clone())))
                    .collect::<Map<String, Value>>(),
            );
            let params = merge_params(&run.params, &spec.params);
            let state = state.clone();
            let semaphore = semaphore.clone();
            let token = token.clone();
            let run_id = run.id;
            handles.push(tokio::spawn(async move {
                // A task queued behind the concurrency limit gives up its
                // slot request the moment the run is cancelled.
                let _permit = tokio::select! {
                    permit = semaphore.acquire() => permit.expect("semaphore open"),
                    _ = token.cancelled() => return (task_run, Err(CANCELLED_BY_USER.to_string())),
                };
                if token.is_cancelled() {
                    return (task_run, Err(CANCELLED_BY_USER.to_string()));
                }
                let outcome =
                    run_task(&state, run_id, &spec, &mut task_run, params, inputs, &token).await;
                (task_run, outcome)
            }));
        }

        for handle in handles {
            match handle.await {
                Ok((task_run, Ok(value))) => {
                    results.insert(task_run.task_id.clone(), value);
                }
                Ok((task_run, Err(message))) => {
                    if token.is_cancelled() {
                        cancelled = true;
                        // Not yet terminal (never started, or still running
                        // when the token fired): swept up below.
                        if !task_run.state.is_terminal() {
                            task_runs.insert(task_run.task_id.clone(), task_run);
                        }
                    } else {
                        failure = Some(format!("task `{}` failed: {message}", task_run.task_id));
                    }
                }
                Err(join_err) => {
                    failure = Some(format!("task panicked: {join_err}"));
                }
            }
        }
        if failure.is_some() || cancelled {
            break 'layers;
        }
    }

    // Tasks never reached (downstream of a failure, or cut off by a cancel)
    // are marked cancelled.
    if failure.is_some() || cancelled || token.is_cancelled() {
        for (_, mut tr) in task_runs.drain() {
            if !tr.state.is_terminal() {
                mark_task_cancelled(&state, &mut tr);
            }
        }
    }

    // Whoever removes the token owns the terminal transition. If it's gone,
    // `cancel_run` already wrote `cancelled` — never overwrite a terminal
    // state.
    let owns_finish = state.cancellations.lock().remove(&run.id).is_some();
    if !owns_finish {
        info!(run = %run.id, "run cancelled");
        return;
    }
    run.finished_at = Some(Utc::now());
    match failure {
        Some(msg) => {
            error!(run = %run.id, "run failed: {msg}");
            run.state = RunState::Failed;
            run.error = Some(msg);
        }
        None => {
            info!(run = %run.id, "run completed");
            run.state = RunState::Completed;
        }
    }
    persist_run(&state, &run);
}

/// Execute one task with retries. Returns the task's result value, or the
/// final error message after all attempts are exhausted (or cancellation).
async fn run_task(
    state: &SharedState,
    run_id: uuid::Uuid,
    spec: &TaskSpec,
    task_run: &mut TaskRun,
    params: Value,
    inputs: Value,
    token: &CancellationToken,
) -> Result<Value, String> {
    task_run.state = RunState::Running;
    task_run.started_at = Some(Utc::now());
    persist_task(state, task_run);

    let max_attempts = spec.retries + 1;
    let mut last_error = String::new();
    for attempt in 1..=max_attempts {
        task_run.attempts = attempt;

        let (log_tx, mut log_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let forwarder_state = state.clone();
        let task_id = spec.id.clone();
        let forwarder = tokio::spawn(async move {
            let mut lines = Vec::new();
            while let Some(line) = log_rx.recv().await {
                forwarder_state.emit(LoomEvent::log(run_id, task_id.clone(), line.clone()));
                lines.push(line);
            }
            lines
        });

        let exec_fut = state.executor.execute(
            ExecRequest {
                runtime: spec.runtime,
                code: spec.code.clone(),
                params: params.clone(),
                inputs: inputs.clone(),
                timeout_secs: spec.timeout_secs,
            },
            Some(log_tx),
        );
        // Dropping `exec_fut` on cancel kills the worker (see
        // `Executor::execute`) and closes `log_tx`, so the forwarder drains
        // and finishes.
        let exec = tokio::select! {
            res = exec_fut => Some(res),
            _ = token.cancelled() => None,
        };
        if let Ok(lines) = forwarder.await {
            task_run.logs.extend(lines);
        }

        match exec {
            None => {
                task_run.error = Some(CANCELLED_BY_USER.to_string());
                mark_task_cancelled(state, task_run);
                return Err(CANCELLED_BY_USER.to_string());
            }
            Some(Ok(outcome)) => {
                task_run.state = RunState::Completed;
                task_run.result = Some(outcome.value.clone());
                task_run.finished_at = Some(Utc::now());
                persist_task(state, task_run);
                return Ok(outcome.value);
            }
            Some(Err(err)) => {
                last_error = describe(&err);
                task_run.error = Some(last_error.clone());
                // Surface the workload's stack trace in the task logs so the
                // console shows *where* user code failed, not just the message.
                if let ExecError::Workload { trace, .. } = &err {
                    for line in trace.lines().filter(|l| !l.trim().is_empty()) {
                        task_run.logs.push(format!("[trace] {line}"));
                    }
                }
                if attempt < max_attempts {
                    state.emit(LoomEvent::log(
                        run_id,
                        spec.id.clone(),
                        format!("attempt {attempt}/{max_attempts} failed ({last_error}); retrying"),
                    ));
                    persist_task(state, task_run);
                }
            }
        }
    }

    task_run.state = RunState::Failed;
    task_run.finished_at = Some(Utc::now());
    persist_task(state, task_run);
    Err(last_error)
}

fn describe(err: &ExecError) -> String {
    match err {
        ExecError::Workload { message, .. } => message.clone(),
        other => other.to_string(),
    }
}

fn persist_run(state: &SharedState, run: &Run) {
    if let Err(e) = state.store.put_run(run) {
        error!(run = %run.id, "failed to persist run: {e}");
    }
    state.emit(LoomEvent::run_updated(run.clone()));
}

fn persist_task(state: &SharedState, task: &TaskRun) {
    if let Err(e) = state.store.put_task_run(task) {
        error!(task = %task.id, "failed to persist task run: {e}");
    }
    state.emit(LoomEvent::task_updated(task.clone()));
}

/// Shallow-merge two JSON values. Objects merge key-by-key (`overlay` wins);
/// anything else: `overlay` replaces `base` unless it is null/absent.
pub fn merge_params(base: &Value, overlay: &Value) -> Value {
    match (base, overlay) {
        (Value::Object(b), Value::Object(o)) => {
            let mut merged = b.clone();
            for (k, v) in o {
                merged.insert(k.clone(), v.clone());
            }
            Value::Object(merged)
        }
        (b, Value::Null) => b.clone(),
        (_, o) => o.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use loom_core::{Runtime, TriggerSpec, WorkflowSpec};
    use loom_executor::Executor;
    use loom_store::Store;
    use serde_json::json;
    use std::time::{Duration, Instant};

    #[test]
    fn overlay_wins_key_by_key() {
        let merged = merge_params(&json!({"a": 1, "b": 2}), &json!({"b": 3, "c": 4}));
        assert_eq!(merged, json!({"a": 1, "b": 3, "c": 4}));
    }

    #[test]
    fn null_overlay_keeps_base() {
        let merged = merge_params(&json!({"a": 1}), &json!(null));
        assert_eq!(merged, json!({"a": 1}));
    }

    fn test_state() -> (SharedState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            Store::open_in_memory().unwrap(),
            Executor::new().unwrap(),
            dir.path().to_path_buf(),
        );
        (state, dir)
    }

    fn workflow(tasks: Vec<TaskSpec>) -> Workflow {
        let now = Utc::now();
        Workflow {
            id: Uuid::new_v4(),
            spec: WorkflowSpec {
                name: "cancel-me".into(),
                description: None,
                params: json!({}),
                tasks,
                triggers: TriggerSpec::default(),
                max_parallel_tasks: 8,
            },
            created_at: now,
            updated_at: now,
        }
    }

    fn task(id: &str, code: &str, depends_on: &[&str]) -> TaskSpec {
        TaskSpec {
            id: id.into(),
            name: None,
            runtime: Runtime::Python,
            code: code.into(),
            depends_on: depends_on.iter().map(|s| s.to_string()).collect(),
            params: json!({}),
            timeout_secs: 60,
            retries: 2,
        }
    }

    #[tokio::test]
    async fn cancel_stops_running_task_and_cancels_downstream() {
        let (state, _dir) = test_state();
        let wf = workflow(vec![
            task(
                "sleep",
                "import time\ndef handler(params, inputs):\n    print('started')\n    time.sleep(5)\n    return 1\n",
                &[],
            ),
            task("after", "def handler(params, inputs):\n    return 2\n", &["sleep"]),
        ]);
        let started = Instant::now();
        let run = launch_run(state.clone(), wf, json!({}), "test").unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;

        let outcome = cancel_run(&state, run.id).unwrap();
        let cancelled_run = match outcome {
            CancelOutcome::Cancelled(r) => r,
            other => panic!("expected Cancelled, got {other:?}"),
        };
        assert_eq!(cancelled_run.state, RunState::Cancelled);
        assert_eq!(cancelled_run.error.as_deref(), Some(CANCELLED_BY_USER));
        assert!(cancelled_run.finished_at.is_some());

        // The background task notices the token and sweeps the tasks.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let tasks = state.store.list_task_runs(run.id).unwrap();
            if tasks.iter().all(|t| t.state == RunState::Cancelled) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "tasks not cancelled in time: {tasks:?}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let tasks = state.store.list_task_runs(run.id).unwrap();
        let sleep = tasks.iter().find(|t| t.task_id == "sleep").unwrap();
        assert_eq!(sleep.attempts, 1, "no retry after cancellation");
        assert!(sleep.finished_at.is_some());
        assert!(
            sleep.logs.iter().any(|l| l == "started"),
            "logs kept: {:?}",
            sleep.logs
        );
        let after = tasks.iter().find(|t| t.task_id == "after").unwrap();
        assert!(after.started_at.is_none(), "downstream never started");

        // Terminal state sticks; registry is clean; the whole thing was fast.
        assert_eq!(
            state.store.get_run(run.id).unwrap().state,
            RunState::Cancelled
        );
        assert!(state.cancellations.lock().is_empty());
        assert!(started.elapsed() < Duration::from_secs(3));

        match cancel_run(&state, run.id).unwrap() {
            CancelOutcome::AlreadyTerminal(r) => assert_eq!(r.state, RunState::Cancelled),
            other => panic!("expected AlreadyTerminal, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn completed_run_cannot_be_cancelled() {
        let (state, _dir) = test_state();
        let wf = workflow(vec![task(
            "quick",
            "def handler(params, inputs):\n    return 1\n",
            &[],
        )]);
        let run = launch_run(state.clone(), wf, json!({}), "test").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while state.store.get_run(run.id).unwrap().state != RunState::Completed {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        match cancel_run(&state, run.id).unwrap() {
            CancelOutcome::AlreadyTerminal(r) => assert_eq!(r.state, RunState::Completed),
            other => panic!("expected AlreadyTerminal, got {other:?}"),
        }
        assert!(state.cancellations.lock().is_empty());
        assert!(matches!(
            cancel_run(&state, Uuid::new_v4()),
            Err(loom_store::StoreError::NotFound(_))
        ));
    }
}
