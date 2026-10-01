//! HTTP surface: REST + SSE + streaming ingestion.

use std::convert::Infallible;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, Uri};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::Utc;
use futures::StreamExt;
use loom_core::{
    validate_dag, Connector, ConnectorKind, Function, FunctionSpec, LoomEvent, Notebook, Run,
    Runtime, Workflow, WorkflowSpec,
};
use loom_executor::{ExecError, ExecRequest};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio_stream::wrappers::{BroadcastStream, UnboundedReceiverStream};
use tower_http::cors::CorsLayer;
use uuid::Uuid;

use crate::auth;
use crate::error::{ApiError, ApiResult};
use crate::orchestrator::{cancel_run, launch_run, merge_params, CancelOutcome};
use crate::state::SharedState;

/// The whole HTTP surface minus the static console: `/api/*` + `/mcp`,
/// behind the auth guard (a no-op unless a password is configured).
pub fn app(state: SharedState) -> Router {
    Router::new()
        .nest("/api", api_router())
        .route("/mcp", post(crate::mcp::handle))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::guard,
        ))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

fn api_router() -> Router<SharedState> {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/auth/status", get(auth::status))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/stats", get(stats))
        .route("/events", get(all_events))
        .route("/workflows", get(list_workflows).post(create_workflow))
        .route(
            "/workflows/{id}",
            get(get_workflow)
                .put(update_workflow)
                .delete(delete_workflow),
        )
        .route("/workflows/{id}/trigger", post(trigger_workflow))
        .route("/runs", get(list_runs))
        .route("/runs/{id}", get(get_run))
        .route("/runs/{id}/cancel", post(cancel_run_handler))
        .route("/runs/{id}/events", get(run_events))
        .route("/functions", get(list_functions).post(create_function))
        .route(
            "/functions/{name}",
            get(get_function).delete(delete_function),
        )
        .route("/functions/{name}/invoke", post(invoke_function))
        .route(
            "/functions/{name}/invoke/stream",
            post(invoke_function_stream),
        )
        .route("/datasets", get(list_datasets))
        .route(
            "/datasets/{name}",
            get(describe_dataset).delete(delete_dataset),
        )
        .route("/ingest/{dataset}", post(ingest))
        .route("/query", post(query))
        .route("/execute", post(execute))
        .route("/connectors", get(list_connectors).post(create_connector))
        .route("/connectors/{name}", delete(delete_connector))
        .route("/notebooks", get(list_notebooks).post(create_notebook))
        .route(
            "/notebooks/{id}",
            get(get_notebook)
                .put(update_notebook)
                .delete(delete_notebook),
        )
        .route("/notebooks/{id}/publish", post(publish_notebook))
        .route("/notebooks/{id}/unpublish", post(unpublish_notebook))
}

async fn healthz() -> Json<Value> {
    Json(json!({ "ok": true, "service": "loom-server" }))
}

async fn stats(State(state): State<SharedState>) -> ApiResult<Json<Value>> {
    Ok(Json(serde_json::to_value(state.store.stats()?).unwrap()))
}

// ── workflows ────────────────────────────────────────────────────────────

async fn list_workflows(State(state): State<SharedState>) -> ApiResult<Json<Vec<Workflow>>> {
    Ok(Json(state.store.list_workflows()?))
}

async fn create_workflow(
    State(state): State<SharedState>,
    Json(spec): Json<WorkflowSpec>,
) -> ApiResult<(StatusCode, Json<Workflow>)> {
    validate_dag(&spec.tasks)?;
    let now = Utc::now();
    let wf = Workflow {
        id: Uuid::new_v4(),
        spec,
        created_at: now,
        updated_at: now,
    };
    state.store.put_workflow(&wf)?;
    Ok((StatusCode::CREATED, Json(wf)))
}

async fn get_workflow(
    State(state): State<SharedState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Workflow>> {
    Ok(Json(state.store.get_workflow(id)?))
}

async fn update_workflow(
    State(state): State<SharedState>,
    Path(id): Path<Uuid>,
    Json(spec): Json<WorkflowSpec>,
) -> ApiResult<Json<Workflow>> {
    validate_dag(&spec.tasks)?;
    let mut wf = state.store.get_workflow(id)?;
    wf.spec = spec;
    wf.updated_at = Utc::now();
    state.store.put_workflow(&wf)?;
    Ok(Json(wf))
}

async fn delete_workflow(
    State(state): State<SharedState>,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    state.store.delete_workflow(id)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
struct TriggerBody {
    #[serde(default)]
    params: Value,
}

async fn trigger_workflow(
    State(state): State<SharedState>,
    Path(id): Path<Uuid>,
    body: Option<Json<TriggerBody>>,
) -> ApiResult<(StatusCode, Json<Run>)> {
    let workflow = state.store.get_workflow(id)?;
    let params = body.map(|Json(b)| b.params).unwrap_or(Value::Null);
    let run = launch_run(state, workflow, params, "manual")?;
    Ok((StatusCode::ACCEPTED, Json(run)))
}

// ── runs ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct RunsQuery {
    workflow_id: Option<Uuid>,
    #[serde(default = "default_limit")]
    limit: u32,
}

fn default_limit() -> u32 {
    50
}

async fn list_runs(
    State(state): State<SharedState>,
    Query(q): Query<RunsQuery>,
) -> ApiResult<Json<Vec<Run>>> {
    Ok(Json(
        state.store.list_runs(q.workflow_id, q.limit.min(500))?,
    ))
}

async fn get_run(State(state): State<SharedState>, Path(id): Path<Uuid>) -> ApiResult<Json<Value>> {
    let run = state.store.get_run(id)?;
    let mut tasks = state.store.list_task_runs(id)?;
    tasks.sort_by(|a, b| {
        a.started_at
            .unwrap_or(chrono::DateTime::<Utc>::MAX_UTC)
            .cmp(&b.started_at.unwrap_or(chrono::DateTime::<Utc>::MAX_UTC))
    });
    Ok(Json(json!({ "run": run, "tasks": tasks })))
}

/// Cancel a pending/running run. 202 with the run (already `cancelled`);
/// 409 if it had reached a terminal state; 404 if unknown.
async fn cancel_run_handler(
    State(state): State<SharedState>,
    Path(id): Path<Uuid>,
) -> ApiResult<(StatusCode, Json<Run>)> {
    match cancel_run(&state, id)? {
        CancelOutcome::Cancelled(run) => Ok((StatusCode::ACCEPTED, Json(run))),
        CancelOutcome::AlreadyTerminal(run) => Err(ApiError::conflict(format!(
            "run is already {}",
            run.state.as_str()
        ))),
    }
}

// ── live event streams (SSE) ─────────────────────────────────────────────

fn sse_stream(
    state: SharedState,
    run_filter: Option<Uuid>,
) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(state.events.subscribe()).filter_map(move |item| {
        let event = match item {
            Ok(ev) => ev,
            // Slow consumer dropped some events; skip rather than kill the stream.
            Err(_) => return futures::future::ready(None),
        };
        if let Some(run_id) = run_filter {
            if event.run_id() != Some(run_id) {
                return futures::future::ready(None);
            }
        }
        let sse = Event::default()
            .json_data(&event)
            .expect("event serializes");
        futures::future::ready(Some(Ok::<_, Infallible>(sse)))
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

async fn all_events(State(state): State<SharedState>) -> impl IntoResponse {
    sse_stream(state, None)
}

async fn run_events(State(state): State<SharedState>, Path(id): Path<Uuid>) -> impl IntoResponse {
    sse_stream(state, Some(id))
}

// ── serverless functions ─────────────────────────────────────────────────

async fn list_functions(State(state): State<SharedState>) -> ApiResult<Json<Vec<Function>>> {
    Ok(Json(state.store.list_functions()?))
}

async fn create_function(
    State(state): State<SharedState>,
    Json(spec): Json<FunctionSpec>,
) -> ApiResult<(StatusCode, Json<Function>)> {
    if spec.name.is_empty() || !is_safe_name(&spec.name) {
        return Err(ApiError::bad_request(
            "function name must match [a-zA-Z0-9_-]{1,64}",
        ));
    }
    let now = Utc::now();
    let func = match state.store.get_function(&spec.name) {
        Ok(mut existing) => {
            existing.spec = spec;
            existing.updated_at = now;
            existing
        }
        Err(_) => Function {
            id: Uuid::new_v4(),
            spec,
            invocations: 0,
            created_at: now,
            updated_at: now,
        },
    };
    state.store.put_function(&func)?;
    Ok((StatusCode::CREATED, Json(func)))
}

async fn get_function(
    State(state): State<SharedState>,
    Path(name): Path<String>,
) -> ApiResult<Json<Function>> {
    Ok(Json(state.store.get_function(&name)?))
}

async fn delete_function(
    State(state): State<SharedState>,
    Path(name): Path<String>,
) -> ApiResult<StatusCode> {
    state.store.delete_function(&name)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
struct InvokeBody {
    #[serde(default)]
    params: Value,
}

async fn invoke_function(
    State(state): State<SharedState>,
    Path(name): Path<String>,
    body: Option<Json<InvokeBody>>,
) -> ApiResult<Json<Value>> {
    let mut func = state.store.get_function(&name)?;
    let params = body.map(|Json(b)| b.params).unwrap_or(Value::Null);
    let started = std::time::Instant::now();
    let exec = state
        .executor
        .execute(
            ExecRequest {
                runtime: func.spec.runtime,
                code: func.spec.code.clone(),
                params: merge_params(&Value::Null, &params),
                inputs: Value::Null,
                timeout_secs: func.spec.timeout_secs,
            },
            None,
        )
        .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    func.invocations += 1;
    state.store.put_function(&func)?;
    let ok = exec.is_ok();
    state.emit(LoomEvent::FunctionInvoked {
        ts: Utc::now(),
        name: name.clone(),
        ok,
        duration_ms,
    });

    match exec {
        Ok(outcome) => Ok(Json(json!({
            "ok": true,
            "result": outcome.value,
            "logs": outcome.logs,
            "duration_ms": duration_ms,
        }))),
        Err(err) => Ok(Json(json!({
            "ok": false,
            "error": err.to_string(),
            "duration_ms": duration_ms,
        }))),
    }
}

/// Streaming invocation: SSE events `log` (one per line, live) then a final
/// `result` or `error` event.
async fn invoke_function_stream(
    State(state): State<SharedState>,
    Path(name): Path<String>,
    body: Option<Json<InvokeBody>>,
) -> ApiResult<impl IntoResponse> {
    let mut func = state.store.get_function(&name)?;
    let params = body.map(|Json(b)| b.params).unwrap_or(Value::Null);

    let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel::<Event>();
    let (log_tx, mut log_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let log_event_tx = event_tx.clone();
    tokio::spawn(async move {
        while let Some(line) = log_rx.recv().await {
            let _ = log_event_tx.send(Event::default().event("log").data(line));
        }
    });

    let exec_state = state.clone();
    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let exec = exec_state
            .executor
            .execute(
                ExecRequest {
                    runtime: func.spec.runtime,
                    code: func.spec.code.clone(),
                    params,
                    inputs: Value::Null,
                    timeout_secs: func.spec.timeout_secs,
                },
                Some(log_tx),
            )
            .await;
        let duration_ms = started.elapsed().as_millis() as u64;
        func.invocations += 1;
        let _ = exec_state.store.put_function(&func);
        let ok = exec.is_ok();
        exec_state.emit(LoomEvent::FunctionInvoked {
            ts: Utc::now(),
            name: func.spec.name.clone(),
            ok,
            duration_ms,
        });
        let final_event = match exec {
            Ok(outcome) => Event::default()
                .event("result")
                .data(json!({ "result": outcome.value, "duration_ms": duration_ms }).to_string()),
            Err(err) => Event::default()
                .event("error")
                .data(json!({ "error": err.to_string(), "duration_ms": duration_ms }).to_string()),
        };
        let _ = event_tx.send(final_event);
    });

    let stream = UnboundedReceiverStream::new(event_rx).map(Ok::<_, Infallible>);
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

// ── datasets & streaming ingestion ───────────────────────────────────────

async fn list_datasets(State(state): State<SharedState>) -> ApiResult<Json<Value>> {
    Ok(Json(
        serde_json::to_value(state.store.list_datasets()?).unwrap(),
    ))
}

#[derive(Deserialize)]
struct DescribeQuery {
    #[serde(default = "default_sample")]
    sample: usize,
}

fn default_sample() -> usize {
    20
}

/// Dataset metadata plus a Polars-computed column profile and a row sample.
async fn describe_dataset(
    State(state): State<SharedState>,
    Path(name): Path<String>,
    Query(q): Query<DescribeQuery>,
) -> ApiResult<Json<Value>> {
    let ds = state.store.get_dataset(&name)?;
    let path = state.dataset_path(&name);
    let sample = q.sample.clamp(1, 200);
    let profile = if path.is_file() {
        tokio::task::spawn_blocking(move || crate::data::describe_dataset(&path, sample))
            .await
            .map_err(|e| ApiError::internal(format!("describe task failed: {e}")))?
            .map_err(ApiError::internal)?
    } else {
        // Registered but nothing on disk (e.g. file removed out of band).
        crate::data::DatasetProfile {
            columns: Vec::new(),
            sample: Vec::new(),
            sample_size: 0,
        }
    };
    Ok(Json(json!({
        "name": ds.name,
        "records": ds.records,
        "bytes": ds.bytes,
        "created_at": ds.created_at,
        "updated_at": ds.updated_at,
        "columns": profile.columns,
        "sample": profile.sample,
        "sample_size": profile.sample_size,
    })))
}

/// Remove a dataset's NDJSON file and its registry row.
async fn delete_dataset(
    State(state): State<SharedState>,
    Path(name): Path<String>,
) -> ApiResult<StatusCode> {
    state.store.get_dataset(&name)?;
    match tokio::fs::remove_file(state.dataset_path(&name)).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    state.store.delete_dataset(&name)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct QueryBody {
    sql: String,
    #[serde(default = "default_query_limit")]
    limit: usize,
    /// Route to a named external connector instead of the embedded engine.
    #[serde(default)]
    connector: Option<String>,
}

fn default_query_limit() -> usize {
    10_000
}

/// SQL over ingested datasets — executed by the embedded Polars engine, or
/// routed to an external connector (Postgres / ClickHouse / chDB).
async fn query(
    State(state): State<SharedState>,
    Json(body): Json<QueryBody>,
) -> ApiResult<Json<Value>> {
    let limit = body.limit.clamp(1, 200_000);
    let started = std::time::Instant::now();

    if let Some(name) = &body.connector {
        let connector = state.store.get_connector(name)?;
        let result = crate::connectors::query(&state, &connector, &body.sql, limit)
            .await
            .map_err(ApiError::bad_request)?;
        return Ok(Json(json!({
            "rows": result.rows,
            "row_count": result.rows.len(),
            "truncated": result.truncated,
            "connector": name,
            "elapsed_ms": started.elapsed().as_millis() as u64,
        })));
    }

    let datasets: Vec<String> = state
        .store
        .list_datasets()?
        .into_iter()
        .map(|d| d.name)
        .collect();
    let dir = state.data_dir.join("datasets");
    let outcome = tokio::task::spawn_blocking(move || {
        crate::data::run_query(&dir, &datasets, &body.sql, limit)
    })
    .await
    .map_err(|e| ApiError::internal(format!("query task failed: {e}")))?
    .map_err(ApiError::bad_request)?;

    let rows: Value = serde_json::from_slice(&outcome.rows_json)
        .map_err(|e| ApiError::internal(format!("bad result encoding: {e}")))?;
    Ok(Json(json!({
        "rows": rows,
        "row_count": outcome.row_count,
        "truncated": outcome.truncated,
        "elapsed_ms": started.elapsed().as_millis() as u64,
    })))
}

// ── direct code execution ────────────────────────────────────────────────

#[derive(Deserialize)]
struct ExecuteBody {
    runtime: Runtime,
    code: String,
    #[serde(default)]
    params: Value,
    /// Optional upstream results passed as the handler's second argument —
    /// notebook cells use this to chain outputs.
    #[serde(default)]
    inputs: Value,
    #[serde(default = "default_exec_timeout")]
    timeout_secs: u64,
}

fn default_exec_timeout() -> u64 {
    120
}

/// Run a snippet of Python/TypeScript/JavaScript on the warm worker pool and
/// return its result + logs. The code must define/export
/// `handler(params, inputs)` like any task.
async fn execute(
    State(state): State<SharedState>,
    Json(body): Json<ExecuteBody>,
) -> ApiResult<Json<Value>> {
    let started = std::time::Instant::now();
    let exec = state
        .executor
        .execute(
            ExecRequest {
                runtime: body.runtime,
                code: body.code,
                params: body.params,
                inputs: body.inputs,
                timeout_secs: body.timeout_secs.clamp(1, 600),
            },
            None,
        )
        .await;
    let duration_ms = started.elapsed().as_millis() as u64;
    match exec {
        Ok(outcome) => Ok(Json(json!({
            "ok": true,
            "result": outcome.value,
            "logs": outcome.logs,
            "duration_ms": duration_ms,
        }))),
        Err(ExecError::Workload { message, trace }) => Ok(Json(json!({
            "ok": false,
            "error": message,
            "trace": trace,
            "duration_ms": duration_ms,
        }))),
        Err(err) => Ok(Json(json!({
            "ok": false,
            "error": err.to_string(),
            "duration_ms": duration_ms,
        }))),
    }
}

// ── connectors ───────────────────────────────────────────────────────────

async fn list_connectors(State(state): State<SharedState>) -> ApiResult<Json<Vec<Connector>>> {
    Ok(Json(state.store.list_connectors()?))
}

#[derive(Deserialize)]
struct ConnectorBody {
    name: String,
    kind: ConnectorKind,
    #[serde(default)]
    url: String,
}

async fn create_connector(
    State(state): State<SharedState>,
    Json(body): Json<ConnectorBody>,
) -> ApiResult<(StatusCode, Json<Connector>)> {
    if !is_safe_name(&body.name) {
        return Err(ApiError::bad_request(
            "connector name must match [a-zA-Z0-9_-]{1,64}",
        ));
    }
    if matches!(
        body.kind,
        ConnectorKind::Postgres | ConnectorKind::Clickhouse
    ) && body.url.is_empty()
    {
        return Err(ApiError::bad_request("this connector kind requires a url"));
    }
    let connector = Connector {
        name: body.name,
        kind: body.kind,
        url: body.url,
        created_at: Utc::now(),
    };
    state.store.put_connector(&connector)?;
    Ok((StatusCode::CREATED, Json(connector)))
}

async fn delete_connector(
    State(state): State<SharedState>,
    Path(name): Path<String>,
) -> ApiResult<StatusCode> {
    state.store.delete_connector(&name)?;
    Ok(StatusCode::NO_CONTENT)
}

// ── notebooks ────────────────────────────────────────────────────────────

/// `?public=1` narrows the list to published notebooks — the only form an
/// anonymous caller may use when auth is enabled.
async fn list_notebooks(
    State(state): State<SharedState>,
    uri: Uri,
) -> ApiResult<Json<Vec<Notebook>>> {
    let mut notebooks = state.store.list_notebooks()?;
    if auth::public_only(&uri) {
        notebooks.retain(|nb| nb.public);
    }
    Ok(Json(notebooks))
}

#[derive(Deserialize)]
struct NotebookBody {
    name: String,
    #[serde(default)]
    cells: Value,
    /// Omitted ⇒ private on create, unchanged on update.
    #[serde(default)]
    public: Option<bool>,
}

async fn create_notebook(
    State(state): State<SharedState>,
    Json(body): Json<NotebookBody>,
) -> ApiResult<(StatusCode, Json<Notebook>)> {
    let now = Utc::now();
    let nb = Notebook {
        id: Uuid::new_v4(),
        name: body.name,
        cells: body.cells,
        public: body.public.unwrap_or(false),
        created_at: now,
        updated_at: now,
    };
    state.store.put_notebook(&nb)?;
    Ok((StatusCode::CREATED, Json(nb)))
}

async fn get_notebook(
    State(state): State<SharedState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Notebook>> {
    Ok(Json(state.store.get_notebook(id)?))
}

async fn update_notebook(
    State(state): State<SharedState>,
    Path(id): Path<Uuid>,
    Json(body): Json<NotebookBody>,
) -> ApiResult<Json<Notebook>> {
    let mut nb = state.store.get_notebook(id)?;
    nb.name = body.name;
    nb.cells = body.cells;
    if let Some(public) = body.public {
        nb.public = public;
    }
    nb.updated_at = Utc::now();
    state.store.put_notebook(&nb)?;
    Ok(Json(nb))
}

/// Publish: the notebook and its stored outputs become readable without
/// authentication (see `auth::guard`). Reading is all it grants — execution
/// routes stay protected.
async fn publish_notebook(
    State(state): State<SharedState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Notebook>> {
    set_notebook_public(&state, id, true)
}

async fn unpublish_notebook(
    State(state): State<SharedState>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Notebook>> {
    set_notebook_public(&state, id, false)
}

/// Visibility is not content: `updated_at` is left alone.
fn set_notebook_public(state: &SharedState, id: Uuid, public: bool) -> ApiResult<Json<Notebook>> {
    let mut nb = state.store.get_notebook(id)?;
    if nb.public != public {
        nb.public = public;
        state.store.put_notebook(&nb)?;
    }
    Ok(Json(nb))
}

async fn delete_notebook(
    State(state): State<SharedState>,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    state.store.delete_notebook(id)?;
    Ok(StatusCode::NO_CONTENT)
}

fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Streaming NDJSON ingestion. The request body is consumed chunk-by-chunk
/// and appended to the dataset's NDJSON file — gigabyte payloads never sit
/// in memory. Workflows with an `on_ingest` trigger for this dataset are
/// launched once the payload is fully persisted.
async fn ingest(
    State(state): State<SharedState>,
    Path(dataset): Path<String>,
    body: Body,
) -> ApiResult<Json<Value>> {
    if !is_safe_name(&dataset) {
        return Err(ApiError::bad_request(
            "dataset name must match [a-zA-Z0-9_-]{1,64}",
        ));
    }

    let dir = state.data_dir.join("datasets");
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join(format!("{dataset}.ndjson"));
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await?;

    let mut records: u64 = 0;
    let mut bytes: u64 = 0;
    let mut ends_with_newline = true;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| ApiError::bad_request(format!("body stream error: {e}")))?;
        if chunk.is_empty() {
            continue;
        }
        records += chunk.iter().filter(|&&b| b == b'\n').count() as u64;
        bytes += chunk.len() as u64;
        ends_with_newline = chunk.last() == Some(&b'\n');
        file.write_all(&chunk).await?;
    }
    if bytes > 0 && !ends_with_newline {
        // Final record had no trailing newline: count it and terminate the line
        // so the next ingest starts fresh.
        records += 1;
        file.write_all(b"\n").await?;
    }
    file.flush().await?;

    let ds = state.store.record_ingest(&dataset, records, bytes)?;
    state.emit(LoomEvent::Ingested {
        ts: Utc::now(),
        dataset: dataset.clone(),
        records,
        bytes,
    });

    // Fire ingest-triggered workflows.
    let mut triggered = Vec::new();
    for wf in state.store.list_workflows()? {
        if wf.spec.triggers.on_ingest.as_deref() == Some(dataset.as_str()) {
            let params = json!({
                "dataset": dataset,
                "records": records,
                "bytes": bytes,
                "path": path.to_string_lossy(),
            });
            let run = launch_run(state.clone(), wf, params, format!("ingest:{dataset}"))?;
            triggered.push(run.id);
        }
    }

    Ok(Json(json!({
        "dataset": ds,
        "ingested": { "records": records, "bytes": bytes },
        "triggered_runs": triggered,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use axum::http::header::{AUTHORIZATION, CONTENT_TYPE, COOKIE, SET_COOKIE};
    use axum::http::{HeaderMap, Method, Request};
    use loom_executor::Executor;
    use loom_store::Store;
    use tower::ServiceExt;

    const PASSWORD: &str = "hunter2";

    /// A router over fresh in-memory state; `password: None` = auth disabled.
    fn test_app(password: Option<&str>) -> (Router, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::with_password(
            Store::open_in_memory().unwrap(),
            Executor::new().unwrap(),
            dir.path().to_path_buf(),
            password.map(String::from),
        );
        (app(state), dir)
    }

    /// Who is asking.
    #[derive(Clone, Copy)]
    enum As<'a> {
        Anonymous,
        Bearer(&'a str),
        Cookie(&'a str),
    }

    async fn call(
        app: &Router,
        who: As<'_>,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut req = Request::builder().method(method).uri(uri);
        req = match who {
            As::Anonymous => req,
            As::Bearer(token) => req.header(AUTHORIZATION, format!("Bearer {token}")),
            As::Cookie(cookie) => req.header(COOKIE, cookie),
        };
        let body = match body {
            Some(json) => {
                req = req.header(CONTENT_TYPE, "application/json");
                Body::from(json.to_string())
            }
            None => Body::empty(),
        };
        let resp = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
        let (status, headers) = (resp.status(), resp.headers().clone());
        // SSE bodies never end; only JSON bodies are read.
        let is_json = headers
            .get(CONTENT_TYPE)
            .is_some_and(|v| v.as_bytes().starts_with(b"application/json"));
        let json = if is_json {
            let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap();
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        (status, headers, json)
    }

    async fn status_of(app: &Router, who: As<'_>, method: Method, uri: &str) -> StatusCode {
        call(app, who, method, uri, None).await.0
    }

    /// Log in and return the `loom_session=<token>` cookie pair.
    async fn login(app: &Router) -> String {
        let (status, headers, body) = call(
            app,
            As::Anonymous,
            Method::POST,
            "/api/auth/login",
            Some(json!({ "password": PASSWORD })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "ok": true }));
        let set_cookie = headers[SET_COOKIE].to_str().unwrap();
        set_cookie.split(';').next().unwrap().to_string()
    }

    async fn create_notebook_as(app: &Router, who: As<'_>, name: &str) -> String {
        let cells = json!([{
            "id": "c1", "kind": "sql", "code": "SELECT 1 AS n",
            "output": { "ok": true, "rows": [{ "n": 1 }] },
        }]);
        let (status, _, nb) = call(
            app,
            who,
            Method::POST,
            "/api/notebooks",
            Some(json!({ "name": name, "cells": cells })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(nb["public"], json!(false), "notebooks start private");
        nb["id"].as_str().unwrap().to_string()
    }

    const EXECUTE: &str = "def handler(params, inputs):\n    return 41 + 1\n";

    #[tokio::test]
    async fn auth_disabled_leaves_everything_open() {
        let (app, _dir) = test_app(None);
        let anon = As::Anonymous;
        for uri in [
            "/api/healthz",
            "/api/stats",
            "/api/workflows",
            "/api/runs",
            "/api/datasets",
        ] {
            assert_eq!(
                status_of(&app, anon, Method::GET, uri).await,
                StatusCode::OK,
                "{uri}"
            );
        }
        let (_, _, status) = call(&app, anon, Method::GET, "/api/auth/status", None).await;
        assert_eq!(status, json!({ "enabled": false, "authenticated": true }));

        // Private notebooks, execution and MCP all work with no credential.
        let id = create_notebook_as(&app, anon, "open").await;
        let (code, _, nb) = call(
            &app,
            anon,
            Method::GET,
            &format!("/api/notebooks/{id}"),
            None,
        )
        .await;
        assert_eq!((code, &nb["name"]), (StatusCode::OK, &json!("open")));
        let (code, _, out) = call(
            &app,
            anon,
            Method::POST,
            "/api/execute",
            Some(json!({ "runtime": "python", "code": EXECUTE })),
        )
        .await;
        assert_eq!((code, &out["result"]), (StatusCode::OK, &json!(42)));
        let (code, _, _) = call(
            &app,
            anon,
            Method::POST,
            "/mcp",
            Some(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        // An empty password is the same as none.
        let (app, _dir) = test_app(Some(""));
        assert_eq!(
            status_of(&app, anon, Method::GET, "/api/stats").await,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn password_set_rejects_requests_without_a_credential() {
        let (app, _dir) = test_app(Some(PASSWORD));
        let anon = As::Anonymous;
        let (code, headers, body) = call(&app, anon, Method::GET, "/api/stats", None).await;
        assert_eq!(code, StatusCode::UNAUTHORIZED);
        assert_eq!(
            body,
            json!({ "error": "unauthorized" }),
            "API error shape kept"
        );
        assert_eq!(headers["www-authenticate"], "Bearer");

        for (method, uri) in [
            (Method::GET, "/api/workflows"),
            (Method::GET, "/api/runs"),
            (Method::GET, "/api/datasets"),
            (Method::GET, "/api/notebooks"),
            (Method::GET, "/api/events"),
            (Method::POST, "/api/query"),
            (Method::POST, "/api/execute"),
            (Method::POST, "/api/ingest/readings"),
            (Method::POST, "/mcp"),
            (Method::GET, "/api/no-such-route"),
        ] {
            assert_eq!(
                status_of(&app, anon, method.clone(), uri).await,
                StatusCode::UNAUTHORIZED,
                "{method} {uri}"
            );
        }
        assert_eq!(
            status_of(&app, As::Bearer("wrong"), Method::GET, "/api/stats").await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            status_of(
                &app,
                As::Cookie("loom_session=forged"),
                Method::GET,
                "/api/stats"
            )
            .await,
            StatusCode::UNAUTHORIZED
        );

        // Always open: health and the auth endpoints themselves.
        assert_eq!(
            status_of(&app, anon, Method::GET, "/api/healthz").await,
            StatusCode::OK
        );
        let (code, _, status) = call(&app, anon, Method::GET, "/api/auth/status", None).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(status, json!({ "enabled": true, "authenticated": false }));
    }

    #[tokio::test]
    async fn bearer_password_grants_access() {
        let (app, _dir) = test_app(Some(PASSWORD));
        let me = As::Bearer(PASSWORD);
        assert_eq!(
            status_of(&app, me, Method::GET, "/api/stats").await,
            StatusCode::OK
        );
        let (code, _, out) = call(
            &app,
            me,
            Method::POST,
            "/api/execute",
            Some(json!({ "runtime": "python", "code": EXECUTE })),
        )
        .await;
        assert_eq!((code, &out["result"]), (StatusCode::OK, &json!(42)));
        let (code, _, tools) = call(
            &app,
            me,
            Method::POST,
            "/mcp",
            Some(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert!(tools["result"]["tools"].is_array());
        let (_, _, status) = call(&app, me, Method::GET, "/api/auth/status", None).await;
        assert_eq!(status, json!({ "enabled": true, "authenticated": true }));
    }

    #[tokio::test]
    async fn login_sets_a_session_cookie_that_authenticates() {
        let (app, _dir) = test_app(Some(PASSWORD));
        let (_, headers, _) = call(
            &app,
            As::Anonymous,
            Method::POST,
            "/api/auth/login",
            Some(json!({ "password": PASSWORD })),
        )
        .await;
        let set_cookie = headers[SET_COOKIE].to_str().unwrap();
        assert!(set_cookie.starts_with("loom_session="));
        assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("SameSite=Lax"));
        assert!(
            !set_cookie.contains("Secure"),
            "plain http request: {set_cookie}"
        );
        assert!(!set_cookie.contains(PASSWORD), "cookie is an opaque token");

        let cookie = login(&app).await;
        let me = As::Cookie(&cookie);
        assert_eq!(
            status_of(&app, me, Method::GET, "/api/stats").await,
            StatusCode::OK
        );
        assert_eq!(
            status_of(&app, me, Method::GET, "/api/events").await,
            StatusCode::OK
        );
        let (_, _, status) = call(&app, me, Method::GET, "/api/auth/status", None).await;
        assert_eq!(status["authenticated"], json!(true));

        // Logout revokes the token server-side, not just in the browser.
        let (code, headers, _) = call(&app, me, Method::POST, "/api/auth/logout", None).await;
        assert_eq!(code, StatusCode::OK);
        assert!(headers[SET_COOKIE].to_str().unwrap().contains("Max-Age=0"));
        assert_eq!(
            status_of(&app, me, Method::GET, "/api/stats").await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn session_cookie_is_secure_behind_https() {
        let (app, _dir) = test_app(Some(PASSWORD));
        let req = Request::builder()
            .method(Method::POST)
            .uri("/api/auth/login")
            .header(CONTENT_TYPE, "application/json")
            .header("x-forwarded-proto", "https")
            .body(Body::from(json!({ "password": PASSWORD }).to_string()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert!(resp.headers()[SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("; Secure"));
    }

    #[tokio::test]
    async fn wrong_password_is_rejected_and_rate_limited() {
        let (app, _dir) = test_app(Some(PASSWORD));
        let attempt = |password: &'static str| {
            let app = app.clone();
            async move {
                call(
                    &app,
                    As::Anonymous,
                    Method::POST,
                    "/api/auth/login",
                    Some(json!({ "password": password })),
                )
                .await
            }
        };
        let (code, headers, body) = attempt("nope").await;
        assert_eq!(code, StatusCode::UNAUTHORIZED);
        assert_eq!(body, json!({ "error": "invalid password" }));
        assert!(headers.get(SET_COOKIE).is_none());

        // Burn the rest of the burst; then even the right password waits.
        let mut last = code;
        for _ in 0..8 {
            last = attempt("nope").await.0;
        }
        assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
        let (code, headers, body) = attempt(PASSWORD).await;
        assert_eq!(code, StatusCode::TOO_MANY_REQUESTS);
        assert!(headers.contains_key("retry-after"));
        assert!(body["error"]
            .as_str()
            .unwrap()
            .contains("too many login attempts"));
    }

    #[tokio::test]
    async fn query_token_works_only_on_sse_routes() {
        let (app, _dir) = test_app(Some(PASSWORD));
        let anon = As::Anonymous;
        let run = Uuid::new_v4();
        for uri in [
            format!("/api/events?token={PASSWORD}"),
            format!("/api/runs/{run}/events?token={PASSWORD}"),
        ] {
            assert_eq!(
                status_of(&app, anon, Method::GET, &uri).await,
                StatusCode::OK,
                "{uri}"
            );
        }
        for uri in [
            "/api/events?token=wrong".to_string(),
            format!("/api/stats?token={PASSWORD}"),
            format!("/api/runs/{run}?token={PASSWORD}"),
        ] {
            assert_eq!(
                status_of(&app, anon, Method::GET, &uri).await,
                StatusCode::UNAUTHORIZED,
                "{uri}"
            );
        }
        assert_eq!(
            status_of(
                &app,
                anon,
                Method::POST,
                &format!("/api/execute?token={PASSWORD}")
            )
            .await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn published_notebook_is_readable_anonymously_but_nothing_else_is() {
        let (app, _dir) = test_app(Some(PASSWORD));
        let (me, anon) = (As::Bearer(PASSWORD), As::Anonymous);
        let public_id = create_notebook_as(&app, me, "report").await;
        let private_id = create_notebook_as(&app, me, "scratch").await;
        let public_uri = format!("/api/notebooks/{public_id}");
        let private_uri = format!("/api/notebooks/{private_id}");

        // Before publishing, neither is visible.
        assert_eq!(
            status_of(&app, anon, Method::GET, &public_uri).await,
            StatusCode::UNAUTHORIZED
        );

        // Publishing itself needs auth.
        let publish = format!("{public_uri}/publish");
        assert_eq!(
            status_of(&app, anon, Method::POST, &publish).await,
            StatusCode::UNAUTHORIZED
        );
        let (code, _, nb) = call(&app, me, Method::POST, &publish, None).await;
        assert_eq!((code, &nb["public"]), (StatusCode::OK, &json!(true)));

        // Anonymous read: the notebook with its stored outputs.
        let (code, _, nb) = call(&app, anon, Method::GET, &public_uri, None).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(nb["name"], json!("report"));
        assert_eq!(nb["cells"][0]["output"]["rows"], json!([{ "n": 1 }]));

        // Private and nonexistent notebooks look the same: 401, never 404.
        let missing = format!("/api/notebooks/{}", Uuid::new_v4());
        for uri in [
            private_uri.as_str(),
            missing.as_str(),
            "/api/notebooks/not-a-uuid",
        ] {
            assert_eq!(
                status_of(&app, anon, Method::GET, uri).await,
                StatusCode::UNAUTHORIZED,
                "{uri}"
            );
        }

        // The public list shows published notebooks only; the full list is protected.
        let (code, _, list) = call(&app, anon, Method::GET, "/api/notebooks?public=1", None).await;
        assert_eq!(code, StatusCode::OK);
        let names: Vec<&str> = list
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["report"]);
        assert_eq!(
            status_of(&app, anon, Method::GET, "/api/notebooks").await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            status_of(&app, anon, Method::GET, "/api/notebooks?public=0").await,
            StatusCode::UNAUTHORIZED
        );
        let (_, _, all) = call(&app, me, Method::GET, "/api/notebooks", None).await;
        assert_eq!(all.as_array().unwrap().len(), 2);

        // A visitor can read, never write or execute — even with a public notebook around.
        for (method, uri) in [
            (Method::PUT, public_uri.as_str()),
            (Method::DELETE, public_uri.as_str()),
            (Method::POST, &format!("{public_uri}/unpublish")),
            (Method::POST, "/api/notebooks"),
            (Method::POST, "/api/execute"),
            (Method::POST, "/api/query"),
            (Method::GET, "/api/datasets"),
            (Method::GET, "/api/connectors"),
        ] {
            let body =
                json!({ "name": "x", "runtime": "python", "code": EXECUTE, "sql": "SELECT 1" });
            let (code, _, err) = call(&app, anon, method.clone(), uri, Some(body)).await;
            assert_eq!(code, StatusCode::UNAUTHORIZED, "{method} {uri}");
            assert_eq!(err, json!({ "error": "unauthorized" }));
        }
        let (_, _, still) = call(&app, me, Method::GET, &public_uri, None).await;
        assert_eq!(
            still["name"],
            json!("report"),
            "anonymous PUT/DELETE changed nothing"
        );

        // Unpublish closes it again.
        let (code, _, nb) = call(
            &app,
            me,
            Method::POST,
            &format!("{public_uri}/unpublish"),
            None,
        )
        .await;
        assert_eq!((code, &nb["public"]), (StatusCode::OK, &json!(false)));
        assert_eq!(
            status_of(&app, anon, Method::GET, &public_uri).await,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn update_preserves_public_unless_told_otherwise() {
        let (app, _dir) = test_app(None);
        let anon = As::Anonymous;
        let id = create_notebook_as(&app, anon, "nb").await;
        let uri = format!("/api/notebooks/{id}");
        call(&app, anon, Method::POST, &format!("{uri}/publish"), None).await;

        // The console autosaves {name, cells}; that must not unpublish.
        let (_, _, nb) = call(
            &app,
            anon,
            Method::PUT,
            &uri,
            Some(json!({ "name": "renamed", "cells": [] })),
        )
        .await;
        assert_eq!(
            (&nb["name"], &nb["public"]),
            (&json!("renamed"), &json!(true))
        );
        let (_, _, nb) = call(
            &app,
            anon,
            Method::PUT,
            &uri,
            Some(json!({ "name": "renamed", "cells": [], "public": false })),
        )
        .await;
        assert_eq!(nb["public"], json!(false));
        assert_eq!(
            status_of(
                &app,
                anon,
                Method::POST,
                &format!("/api/notebooks/{}/publish", Uuid::new_v4())
            )
            .await,
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn notebooks_stored_before_publishing_existed_are_private() {
        let old = json!({
            "id": Uuid::new_v4(), "name": "old", "cells": [],
            "created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-01T00:00:00Z",
        });
        let nb: Notebook = serde_json::from_value(old).unwrap();
        assert!(!nb.public);
    }
}
