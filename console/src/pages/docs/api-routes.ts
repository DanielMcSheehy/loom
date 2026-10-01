// Structured REST reference. Every entry mirrors a `.route(...)` in
// crates/loom-server/src/routes.rs (plus the MCP endpoint mounted in
// main.rs); response shapes are the exact `json!` bodies those handlers
// build. Keep this in lockstep with the router.
import type { ApiRoute } from "./primitives";

export interface RouteGroup {
  id: string;
  title: string;
  intro?: string;
  routes: ApiRoute[];
}

const ERR_404_WF = { status: "404 Not Found", when: "No workflow with that id — `{\"error\": \"not found: workflow <id>\"}`." };

export const ROUTE_GROUPS: RouteGroup[] = [
  {
    id: "health",
    title: "Health & stats",
    routes: [
      {
        method: "GET",
        path: "/api/healthz",
        summary: "Liveness probe.",
        status: "200 OK",
        response: `{ "ok": true, "service": "loom-server" }`,
        examples: { curl: `curl localhost:7420/api/healthz` },
      },
      {
        method: "GET",
        path: "/api/stats",
        summary: "Aggregate counters for the dashboard.",
        status: "200 OK",
        response: `{
  "workflows": 3,
  "functions": 2,
  "datasets": 4,
  "runs_total": 128,
  "runs_running": 1,
  "runs_completed": 120,
  "runs_failed": 7,
  "records_ingested": 1700000,
  "bytes_ingested": 104857600
}`,
        examples: {
          curl: `curl localhost:7420/api/stats`,
          python: `client.stats()`,
          typescript: `await client.stats();`,
        },
      },
    ],
  },
  {
    id: "auth",
    title: "Authentication",
    intro: "Only relevant when the server was started with LOOM_PASSWORD; without it these routes still answer, and nothing requires a credential. API clients skip the session entirely and send Authorization: Bearer <password> on every request. All three routes are always open.",
    routes: [
      {
        method: "GET",
        path: "/api/auth/status",
        summary: "Whether auth is enabled, and whether this request is authenticated.",
        description: "The console calls this on load to choose between the app and the login screen. authenticated is true whenever the caller has full access — including when auth is disabled.",
        status: "200 OK",
        response: `{ "enabled": true, "authenticated": false }`,
        examples: { curl: `curl localhost:7420/api/auth/status` },
      },
      {
        method: "POST",
        path: "/api/auth/login",
        summary: "Exchange the password for a session cookie.",
        description: "Sets loom_session: an opaque random token (HttpOnly, SameSite=Lax, Secure behind HTTPS, 30 days). Sessions are held in memory, so a server restart ends them. Failed attempts are rate-limited per client address: a burst of five, then one every two seconds.",
        body: [{ name: "password", type: "string", desc: "The server's LOOM_PASSWORD." }],
        status: "200 OK",
        response: `{ "ok": true }`,
        errors: [
          { status: "401 Unauthorized", when: "Wrong password — `{\"error\": \"invalid password\"}`." },
          { status: "429 Too Many Requests", when: "Too many failed attempts from this address; see the Retry-After header." },
        ],
        examples: {
          curl: `curl -c cookies.txt -X POST localhost:7420/api/auth/login \\
  -H 'content-type: application/json' -d '{"password": "'"$LOOM_PASSWORD"'"}'
curl -b cookies.txt localhost:7420/api/stats`,
        },
      },
      {
        method: "POST",
        path: "/api/auth/logout",
        summary: "End the session.",
        description: "Revokes the session token server-side and clears the cookie. Safe to call without a session.",
        status: "200 OK",
        response: `{ "ok": true }`,
        examples: { curl: `curl -b cookies.txt -X POST localhost:7420/api/auth/logout` },
      },
    ],
  },
  {
    id: "workflows",
    title: "Workflows",
    intro: "A workflow is a stored WorkflowSpec plus an id. The DAG is validated on create and update.",
    routes: [
      {
        method: "GET",
        path: "/api/workflows",
        summary: "List all workflows.",
        status: "200 OK",
        response: `[
  {
    "id": "6f1c…",
    "spec": {
      "name": "hello-pipeline",
      "description": null,
      "params": { "n": 100 },
      "tasks": [ { "id": "extract", "name": null, "runtime": "python", "code": "…", "depends_on": [], "params": null, "timeout_secs": 300, "retries": 0 } ],
      "triggers": {},
      "max_parallel_tasks": 8
    },
    "created_at": "2026-09-30T10:00:00Z",
    "updated_at": "2026-09-30T10:00:00Z"
  }
]`,
        examples: {
          curl: `curl localhost:7420/api/workflows`,
          python: `client.list_workflows()`,
          typescript: `await client.listWorkflows();`,
        },
      },
      {
        method: "POST",
        path: "/api/workflows",
        summary: "Create a workflow from a WorkflowSpec.",
        description: "The task graph is validated first (non-empty, unique ids, known dependencies, no self-dependencies, no cycles).",
        body: [
          { name: "name", type: "string", desc: "Workflow name. Not unique on this route (the SDKs and MCP upsert by name themselves)." },
          { name: "description", type: "string | null", note: "null", desc: "Free text." },
          { name: "params", type: "json", note: "null", desc: "Default run parameters; trigger params are merged over them." },
          { name: "tasks", type: "TaskSpec[]", desc: "The DAG. See the Workflows guide for TaskSpec fields." },
          { name: "triggers", type: "{ every_secs?, on_ingest? }", note: "{}", desc: "Interval in seconds and/or a dataset name." },
          { name: "max_parallel_tasks", type: "integer", note: "8", desc: "Concurrency cap within one run (a value of 0 behaves like 1)." },
        ],
        status: "201 Created",
        response: `{ "id": "6f1c…", "spec": { …the spec you sent, with defaults filled… }, "created_at": "…", "updated_at": "…" }`,
        errors: [{ status: "400 Bad Request", when: "Invalid DAG — `{\"error\": \"invalid workflow DAG: dependency cycle involving tasks: [\\\"a\\\", \\\"b\\\"]\"}`." }],
        examples: {
          curl: `curl -X POST localhost:7420/api/workflows -H 'content-type: application/json' -d '{
  "name": "hello-pipeline",
  "params": {"n": 100},
  "tasks": [
    {"id": "extract", "runtime": "python",
     "code": "def handler(params, inputs):\\n    return {\\"values\\": list(range(params[\\"n\\"]))}\\n"},
    {"id": "total", "runtime": "typescript", "depends_on": ["extract"],
     "code": "export function handler(params: any, inputs: any) {\\n  return inputs.extract.values.reduce((a: number, b: number) => a + b, 0);\\n}\\n"}
  ]
}'`,
          python: `wf = client.deploy(Flow("hello-pipeline", params={"n": 100}, tasks=[extract, total]))`,
          typescript: `const wf = await client.deploy(flow("hello-pipeline", [extract, total], { params: { n: 100 } }));`,
        },
      },
      {
        method: "GET",
        path: "/api/workflows/{id}",
        summary: "Fetch one workflow.",
        params: [{ name: "id", desc: "Workflow UUID." }],
        status: "200 OK",
        response: `{ "id": "6f1c…", "spec": { … }, "created_at": "…", "updated_at": "…" }`,
        errors: [ERR_404_WF],
        examples: {
          curl: `curl localhost:7420/api/workflows/$WF`,
          python: `client.get_workflow(wf["id"])`,
          typescript: `await client.getWorkflow(wf.id);`,
        },
      },
      {
        method: "PUT",
        path: "/api/workflows/{id}",
        summary: "Replace a workflow's spec.",
        description: "Same body and validation as create; the id and created_at are kept, updated_at is bumped.",
        params: [{ name: "id", desc: "Workflow UUID." }],
        bodyNote: "A full WorkflowSpec (see POST /api/workflows).",
        status: "200 OK",
        response: `{ "id": "6f1c…", "spec": { …new spec… }, "created_at": "…", "updated_at": "…" }`,
        errors: [{ status: "400 Bad Request", when: "Invalid DAG." }, ERR_404_WF],
        examples: {
          curl: `curl -X PUT localhost:7420/api/workflows/$WF -H 'content-type: application/json' -d @workflow.json`,
          python: `client.deploy(flow)  # PUTs when a workflow with flow.name already exists`,
          typescript: `await client.deploy(spec); // PUTs when a workflow with spec.name already exists`,
        },
      },
      {
        method: "DELETE",
        path: "/api/workflows/{id}",
        summary: "Delete a workflow.",
        params: [{ name: "id", desc: "Workflow UUID." }],
        status: "204 No Content",
        response: `(empty body)`,
        responseLang: "plain",
        errors: [ERR_404_WF],
        examples: {
          curl: `curl -X DELETE localhost:7420/api/workflows/$WF`,
          python: `client.delete_workflow(wf["id"])`,
          typescript: `await client.deleteWorkflow(wf.id);`,
        },
      },
      {
        method: "POST",
        path: "/api/workflows/{id}/trigger",
        summary: "Start a run.",
        description: "Returns immediately with the pending run; the orchestrator executes it in the background. The run's trigger is recorded as \"manual\".",
        params: [{ name: "id", desc: "Workflow UUID." }],
        body: [{ name: "params", type: "json", note: "null", desc: "Merged over the workflow's params (objects merge key by key, overlay wins). The body itself is optional." }],
        status: "202 Accepted",
        response: `{
  "id": "9a2d…",
  "workflow_id": "6f1c…",
  "workflow_name": "hello-pipeline",
  "state": "pending",
  "params": { "n": 100 },
  "trigger": "manual",
  "error": null,
  "created_at": "…",
  "started_at": null,
  "finished_at": null
}`,
        errors: [ERR_404_WF],
        examples: {
          curl: `curl -X POST localhost:7420/api/workflows/$WF/trigger -H 'content-type: application/json' -d '{"params": {"n": 5}}'`,
          python: `run = client.trigger(wf["id"], params={"n": 5}, wait=True)`,
          typescript: `const run = await client.trigger(wf.id, { params: { n: 5 }, wait: true });`,
        },
      },
    ],
  },
  {
    id: "runs",
    title: "Runs",
    routes: [
      {
        method: "GET",
        path: "/api/runs",
        summary: "Run history, newest first.",
        query: [
          { name: "workflow_id", type: "uuid", note: "any", desc: "Only runs of this workflow." },
          { name: "limit", type: "integer", note: "50", desc: "Maximum rows (capped at 500)." },
        ],
        status: "200 OK",
        response: `[ { "id": "9a2d…", "workflow_id": "6f1c…", "workflow_name": "hello-pipeline", "state": "completed", "params": {…}, "trigger": "manual", "error": null, "created_at": "…", "started_at": "…", "finished_at": "…" } ]`,
        examples: {
          curl: `curl 'localhost:7420/api/runs?workflow_id='$WF'&limit=20'`,
          python: `client.list_runs(workflow_id=wf["id"], limit=20)`,
          typescript: `await client.listRuns({ workflowId: wf.id, limit: 20 });`,
        },
      },
      {
        method: "GET",
        path: "/api/runs/{id}",
        summary: "A run plus every task run, with results, errors, and logs.",
        description: "Tasks are ordered by start time; tasks that never started sort last.",
        params: [{ name: "id", desc: "Run UUID." }],
        status: "200 OK",
        response: `{
  "run": { "id": "9a2d…", "state": "completed", "trigger": "manual", "params": {…}, "error": null, … },
  "tasks": [
    {
      "id": "c1…", "run_id": "9a2d…", "task_id": "extract", "name": "extract",
      "state": "completed", "attempts": 1,
      "result": { "values": [0, 1, 2] }, "error": null,
      "logs": ["pulling 3 records"],
      "started_at": "…", "finished_at": "…"
    }
  ]
}`,
        errors: [{ status: "404 Not Found", when: "Unknown run id." }],
        examples: {
          curl: `curl localhost:7420/api/runs/$RUN`,
          python: `client.get_run(run["id"])["tasks"]`,
          typescript: `const { run, tasks } = await client.getRun(runId);`,
        },
      },
      {
        method: "POST",
        path: "/api/runs/{id}/cancel",
        summary: "Cancel a pending or running run.",
        description: "The run is marked cancelled synchronously (error \"cancelled by user\"); in-flight workers are killed and outstanding tasks are marked cancelled by the orchestrator.",
        params: [{ name: "id", desc: "Run UUID." }],
        status: "202 Accepted",
        response: `{ "id": "9a2d…", "state": "cancelled", "error": "cancelled by user", "finished_at": "…", … }`,
        errors: [
          { status: "409 Conflict", when: "The run already reached a terminal state — `{\"error\": \"run is already completed\"}`." },
          { status: "404 Not Found", when: "Unknown run id." },
        ],
        examples: {
          curl: `curl -X POST localhost:7420/api/runs/$RUN/cancel`,
          python: `client.cancel_run(run["id"])  # raises LoomError(409) if already finished`,
          typescript: `await client.cancelRun(run.id); // rejects with LoomError 409 if already finished`,
        },
      },
    ],
  },
  {
    id: "events",
    title: "Live events (SSE)",
    intro: "Server-sent events with a 15-second keep-alive. Each message's data is one LoomEvent JSON object; see Runs & events for the variants.",
    routes: [
      {
        method: "GET",
        path: "/api/events",
        summary: "Every event on the platform.",
        description: "Run and task updates, log lines, ingests, and function invocations. With LOOM_PASSWORD set, browsers' EventSource cannot send a header: the two SSE routes (and only these) also accept ?token=<password>.",
        status: "200 OK · text/event-stream",
        response: `data: {"type":"run_updated","ts":"…","run":{…}}

data: {"type":"log","ts":"…","run_id":"9a2d…","task_id":"extract","line":"pulling 3 records"}

data: {"type":"ingested","ts":"…","dataset":"readings","records":5000,"bytes":231000}`,
        responseLang: "plain",
        examples: {
          curl: `curl -N localhost:7420/api/events
curl -N "localhost:7420/api/events?token=$LOOM_PASSWORD"   # when the server has a password`,
          python: `for event in client.events():
    print(event["type"])`,
          typescript: `for await (const event of client.events()) console.log(event.type);`,
        },
      },
      {
        method: "GET",
        path: "/api/runs/{id}/events",
        summary: "Events for one run only.",
        description: "Filters the stream to run_updated, task_updated, and log events whose run id matches. Events that happened before you connected are not replayed — fetch the run first.",
        params: [{ name: "id", desc: "Run UUID (not validated against the store; an unknown id yields a silent stream)." }],
        status: "200 OK · text/event-stream",
        response: `data: {"type":"task_updated","ts":"…","task":{"task_id":"extract","state":"running",…}}

data: {"type":"run_updated","ts":"…","run":{"state":"completed",…}}`,
        responseLang: "plain",
        examples: {
          curl: `curl -N localhost:7420/api/runs/$RUN/events`,
          python: `for event in client.stream_run(run["id"]):   # stops at the terminal run_updated
    if event["type"] == "log": print(event["line"])`,
          typescript: `for await (const ev of client.streamRun(run.id)) {
  if (ev.type === "log") console.log(ev.line);
}`,
        },
      },
    ],
  },
  {
    id: "functions",
    title: "Functions",
    intro: "Named single-shot handlers. Names must match [a-zA-Z0-9_-]{1,64}.",
    routes: [
      {
        method: "GET",
        path: "/api/functions",
        summary: "List deployed functions.",
        status: "200 OK",
        response: `[ { "id": "…", "spec": { "name": "hello", "description": null, "runtime": "python", "code": "…", "timeout_secs": 300 }, "invocations": 12, "created_at": "…", "updated_at": "…" } ]`,
        examples: {
          curl: `curl localhost:7420/api/functions`,
          python: `client.list_functions()`,
          typescript: `// no listFunctions helper in the TypeScript SDK; call the route directly
await fetch("http://localhost:7420/api/functions").then((r) => r.json());`,
        },
      },
      {
        method: "POST",
        path: "/api/functions",
        summary: "Deploy a function, or replace one with the same name.",
        description: "Upsert by name: an existing function keeps its id and invocation count.",
        body: [
          { name: "name", type: "string", desc: "[a-zA-Z0-9_-]{1,64}." },
          { name: "description", type: "string | null", note: "null", desc: "Free text." },
          { name: "runtime", type: "\"python\" | \"typescript\" | \"javascript\"", desc: "Worker runtime." },
          { name: "code", type: "string", desc: "Module source defining/exporting handler(params, inputs)." },
          { name: "timeout_secs", type: "integer", note: "300", desc: "Kill the worker after this long." },
        ],
        status: "201 Created",
        response: `{ "id": "…", "spec": { "name": "hello", "description": null, "runtime": "python", "code": "…", "timeout_secs": 300 }, "invocations": 0, "created_at": "…", "updated_at": "…" }`,
        errors: [{ status: "400 Bad Request", when: "`{\"error\": \"function name must match [a-zA-Z0-9_-]{1,64}\"}`." }],
        examples: {
          curl: `curl -X POST localhost:7420/api/functions -H 'content-type: application/json' -d '{
  "name": "hello", "runtime": "python",
  "code": "def handler(params, inputs):\\n    return f\\"hi {params[\\"name\\"]}\\"\\n"
}'`,
          python: `client.create_function("hello", "def handler(params, inputs):\\n    return f\\"hi {params['name']}\\"\\n")`,
          typescript: `await client.createFunction({ name: "hello", code: 'export const handler = (params) => \`hi \${params.name}\`;' });`,
        },
      },
      {
        method: "GET",
        path: "/api/functions/{name}",
        summary: "Fetch one function.",
        params: [{ name: "name", desc: "Function name." }],
        status: "200 OK",
        response: `{ "id": "…", "spec": { … }, "invocations": 12, "created_at": "…", "updated_at": "…" }`,
        errors: [{ status: "404 Not Found", when: "`{\"error\": \"not found: function hello\"}`." }],
        examples: { curl: `curl localhost:7420/api/functions/hello` },
      },
      {
        method: "DELETE",
        path: "/api/functions/{name}",
        summary: "Remove a function.",
        params: [{ name: "name", desc: "Function name." }],
        status: "204 No Content",
        response: `(empty body)`,
        responseLang: "plain",
        errors: [{ status: "404 Not Found", when: "Unknown function." }],
        examples: {
          curl: `curl -X DELETE localhost:7420/api/functions/hello`,
          python: `client.delete_function("hello")`,
          typescript: `await client.deleteFunction("hello");`,
        },
      },
      {
        method: "POST",
        path: "/api/functions/{name}/invoke",
        summary: "Invoke a function and wait for its result.",
        description: "Always HTTP 200 once the function exists: a failing handler is reported in the body with ok: false. The invocation counter is incremented either way and a function_invoked event is emitted.",
        params: [{ name: "name", desc: "Function name." }],
        body: [{ name: "params", type: "json", note: "null", desc: "Passed as the handler's first argument (inputs is null). The body itself is optional." }],
        status: "200 OK",
        response: `// success
{ "ok": true, "result": "hi loom", "logs": ["…"], "duration_ms": 1 }

// handler raised / timed out
{ "ok": false, "error": "workload failed: KeyError: 'name'", "duration_ms": 1 }`,
        errors: [{ status: "404 Not Found", when: "Unknown function." }],
        examples: {
          curl: `curl -X POST localhost:7420/api/functions/hello/invoke -H 'content-type: application/json' -d '{"params": {"name": "loom"}}'`,
          python: `client.invoke("hello", {"name": "loom"})   # {"ok": True, "result": "hi loom", ...}`,
          typescript: `const { ok, result } = await client.invoke("hello", { name: "loom" });`,
        },
      },
      {
        method: "POST",
        path: "/api/functions/{name}/invoke/stream",
        summary: "Invoke a function and stream its logs as SSE.",
        description: "Named events: one `log` per line as it is printed, then exactly one `result` or `error`. Not wrapped by the SDKs.",
        params: [{ name: "name", desc: "Function name." }],
        body: [{ name: "params", type: "json", note: "null", desc: "Handler's first argument. Optional body." }],
        status: "200 OK · text/event-stream",
        response: `event: log
data: step 1

event: result
data: {"result": "hi loom", "duration_ms": 3}

// or
event: error
data: {"error": "workload timed out after 300s", "duration_ms": 300004}`,
        responseLang: "plain",
        errors: [{ status: "404 Not Found", when: "Unknown function." }],
        examples: {
          curl: `curl -N -X POST localhost:7420/api/functions/hello/invoke/stream -H 'content-type: application/json' -d '{"params": {"name": "loom"}}'`,
        },
      },
    ],
  },
  {
    id: "datasets",
    title: "Datasets & ingestion",
    intro: "A dataset is an NDJSON file under LOOM_DATA_DIR/datasets/<name>.ndjson plus a registry row with counters. Names must match [a-zA-Z0-9_-]{1,64}.",
    routes: [
      {
        method: "POST",
        path: "/api/ingest/{dataset}",
        summary: "Append NDJSON records to a dataset (creating it on first use).",
        description: "The body is streamed to disk chunk by chunk, so payloads of any size never sit in memory. Records are counted by newline; a final line without a newline is counted and terminated. Workflows whose triggers.on_ingest names this dataset are launched once the payload is persisted, and an ingested event is emitted.",
        params: [{ name: "dataset", desc: "Dataset name, [a-zA-Z0-9_-]{1,64}." }],
        bodyNote: "Raw NDJSON — one JSON object per line (content-type application/x-ndjson). Records are not validated on write; malformed lines surface as query errors later.",
        status: "200 OK",
        response: `{
  "dataset": { "name": "readings", "records": 15000, "bytes": 693000, "created_at": "…", "updated_at": "…" },
  "ingested": { "records": 5000, "bytes": 231000 },
  "triggered_runs": ["9a2d…"]
}`,
        errors: [{ status: "400 Bad Request", when: "`{\"error\": \"dataset name must match [a-zA-Z0-9_-]{1,64}\"}`, or the body stream failed." }],
        examples: {
          curl: `printf '{"sensor":"a","value":10}\\n{"sensor":"b","value":5}\\n' \\
  | curl -X POST localhost:7420/api/ingest/readings -H 'content-type: application/x-ndjson' --data-binary @-`,
          python: `client.ingest("readings", ({"sensor": f"s{i % 4}", "value": i * 0.5} for i in range(5000)))`,
          typescript: `await client.ingest("readings", [{ sensor: "a", value: 10 }, { sensor: "b", value: 5 }]);`,
        },
      },
      {
        method: "GET",
        path: "/api/datasets",
        summary: "List datasets with record and byte counters.",
        status: "200 OK",
        response: `[ { "name": "readings", "records": 15000, "bytes": 693000, "created_at": "…", "updated_at": "…" } ]`,
        examples: {
          curl: `curl localhost:7420/api/datasets`,
          python: `client.list_datasets()`,
          typescript: `await client.listDatasets();`,
        },
      },
      {
        method: "GET",
        path: "/api/datasets/{name}",
        summary: "Dataset metadata, a Polars column profile, and a row sample.",
        description: "The profile scans the whole file (schema inferred from the first 1000 lines). A registered dataset whose file is missing returns empty columns and sample.",
        params: [{ name: "name", desc: "Dataset name." }],
        query: [{ name: "sample", type: "integer", note: "20", desc: "Rows to return from the head of the file, clamped to 1..200." }],
        status: "200 OK",
        response: `{
  "name": "readings", "records": 15000, "bytes": 693000, "created_at": "…", "updated_at": "…",
  "columns": [
    { "name": "sensor", "dtype": "string",  "null_count": 0, "min": "s0", "max": "s3", "mean": null, "distinct": 4 },
    { "name": "value",  "dtype": "float",   "null_count": 0, "min": 0.0,  "max": 2499.5, "mean": 1249.75, "distinct": 5000 }
  ],
  "sample": [ { "sensor": "s0", "value": 0.0 }, … ],
  "sample_size": 20
}`,
        errors: [
          { status: "404 Not Found", when: "`{\"error\": \"not found: dataset readings\"}`." },
          { status: "500 Internal Server Error", when: "The file could not be scanned (e.g. malformed NDJSON)." },
        ],
        examples: {
          curl: `curl 'localhost:7420/api/datasets/readings?sample=5'`,
          python: `profile = client.describe_dataset("readings", sample=5)
print(profile["columns"])`,
          typescript: `const profile = await client.describeDataset("readings", { sample: 5 });`,
        },
      },
      {
        method: "DELETE",
        path: "/api/datasets/{name}",
        summary: "Delete a dataset's file and registry row.",
        params: [{ name: "name", desc: "Dataset name." }],
        status: "204 No Content",
        response: `(empty body)`,
        responseLang: "plain",
        errors: [{ status: "404 Not Found", when: "Unknown dataset." }],
        examples: {
          curl: `curl -X DELETE localhost:7420/api/datasets/readings`,
          python: `client.delete_dataset("readings")`,
          typescript: `await client.deleteDataset("readings");`,
        },
      },
    ],
  },
  {
    id: "query",
    title: "SQL & execution",
    routes: [
      {
        method: "POST",
        path: "/api/query",
        summary: "Run SQL on the embedded Polars engine, or on a registered connector.",
        description: "Without a connector every dataset is a table named after itself (dashes also aliased to underscores). Results are capped at limit rows with a truncated flag.",
        body: [
          { name: "sql", type: "string", desc: "The query." },
          { name: "limit", type: "integer", note: "10000", desc: "Row cap, clamped to 1..200000." },
          { name: "connector", type: "string", note: "none", desc: "Name of a registered Postgres / ClickHouse / chDB connector to run against instead." },
        ],
        status: "200 OK",
        response: `{
  "rows": [ { "sensor": "s0", "avg_value": 1248.0, "n": 1250 }, … ],
  "row_count": 4,
  "truncated": false,
  "elapsed_ms": 12
}
// with "connector": the object also carries "connector": "<name>"`,
        errors: [
          { status: "400 Bad Request", when: "`{\"error\": \"query failed: …\"}` (bad SQL, unknown table) or a connector error." },
          { status: "404 Not Found", when: "Unknown connector name." },
        ],
        examples: {
          curl: `curl -X POST localhost:7420/api/query -H 'content-type: application/json' \\
  -d '{"sql": "SELECT sensor, AVG(value) AS avg_value, COUNT(*) AS n FROM readings GROUP BY sensor ORDER BY sensor"}'`,
          python: `rows = client.query("SELECT sensor, AVG(value) AS avg_value FROM readings GROUP BY sensor")
rows = client.query("SELECT now()", connector="warehouse")`,
          typescript: `const rows = await client.query("SELECT sensor, AVG(value) AS avg_value FROM readings GROUP BY sensor");
const pg = await client.query("SELECT now()", { connector: "warehouse" });`,
        },
      },
      {
        method: "POST",
        path: "/api/execute",
        summary: "Run a code snippet on the warm worker pool.",
        description: "The building block for notebooks and agents. The code must define (Python) or export (JS/TS) handler(params, inputs). Like invoke, a failing handler is an HTTP 200 with ok: false.",
        body: [
          { name: "runtime", type: "\"python\" | \"typescript\" | \"javascript\"", desc: "Worker runtime." },
          { name: "code", type: "string", desc: "Module source." },
          { name: "params", type: "json", note: "null", desc: "Handler's first argument." },
          { name: "inputs", type: "json", note: "null", desc: "Handler's second argument — notebooks pass upstream cell outputs here." },
          { name: "timeout_secs", type: "integer", note: "120", desc: "Clamped to 1..600." },
        ],
        status: "200 OK",
        response: `// success
{ "ok": true, "result": { "n": 3 }, "logs": ["hello"], "duration_ms": 2 }

// the handler raised
{ "ok": false, "error": "ZeroDivisionError: division by zero", "trace": "Traceback (most recent call last): …", "duration_ms": 2 }

// timeout / worker failure
{ "ok": false, "error": "workload timed out after 5s", "duration_ms": 5003 }`,
        examples: {
          curl: `curl -X POST localhost:7420/api/execute -H 'content-type: application/json' -d '{
  "runtime": "python",
  "code": "def handler(params, inputs):\\n    print(\\"hello\\")\\n    return {\\"n\\": len(inputs[\\"rows\\"])}\\n",
  "inputs": {"rows": [1, 2, 3]}
}'`,
          python: `client.execute("def handler(params, inputs):\\n    return len(inputs['rows'])\\n", inputs={"rows": [1, 2, 3]})`,
          typescript: `await client.execute({ runtime: "javascript", code: "export const handler = (p, i) => i.rows.length;", inputs: { rows: [1, 2, 3] } });`,
        },
      },
    ],
  },
  {
    id: "connectors",
    title: "Connectors",
    intro: "External query engines addressable from POST /api/query. URLs are stored in plaintext in SQLite.",
    routes: [
      {
        method: "GET",
        path: "/api/connectors",
        summary: "List connectors.",
        status: "200 OK",
        response: `[ { "name": "warehouse", "kind": "postgres", "url": "postgres://user:pw@host:5432/db", "created_at": "…" } ]`,
        examples: { curl: `curl localhost:7420/api/connectors` },
      },
      {
        method: "POST",
        path: "/api/connectors",
        summary: "Register a connector (replacing one with the same name).",
        body: [
          { name: "name", type: "string", desc: "[a-zA-Z0-9_-]{1,64}." },
          { name: "kind", type: "\"postgres\" | \"clickhouse\" | \"chdb\"", desc: "Engine." },
          { name: "url", type: "string", note: "\"\"", desc: "postgres://… or the ClickHouse HTTP URL (http://host:8123). Required for postgres and clickhouse; unused for chdb." },
        ],
        status: "201 Created",
        response: `{ "name": "warehouse", "kind": "postgres", "url": "postgres://…", "created_at": "…" }`,
        errors: [{ status: "400 Bad Request", when: "Bad name, or `{\"error\": \"this connector kind requires a url\"}`." }],
        examples: {
          curl: `curl -X POST localhost:7420/api/connectors -H 'content-type: application/json' \\
  -d '{"name": "warehouse", "kind": "postgres", "url": "postgres://user:pw@localhost:5432/app"}'`,
        },
      },
      {
        method: "DELETE",
        path: "/api/connectors/{name}",
        summary: "Remove a connector.",
        params: [{ name: "name", desc: "Connector name." }],
        status: "204 No Content",
        response: `(empty body)`,
        responseLang: "plain",
        errors: [{ status: "404 Not Found", when: "Unknown connector." }],
        examples: { curl: `curl -X DELETE localhost:7420/api/connectors/warehouse` },
      },
    ],
  },
  {
    id: "notebooks",
    title: "Notebooks",
    intro: "Notebook documents are stored as opaque JSON: the console owns the cell schema, and cells execute through /api/execute and /api/query. A published notebook (public: true) can be read — never run or changed — without authentication.",
    routes: [
      {
        method: "GET",
        path: "/api/notebooks",
        summary: "List notebooks (with their cells).",
        query: [{ name: "public", type: "1 | true", note: "optional", desc: "Only published notebooks. With LOOM_PASSWORD set, this is the one form of the list that needs no authentication." }],
        status: "200 OK",
        response: `[ { "id": "…", "name": "Sensor analysis", "cells": [ … ], "public": false, "created_at": "…", "updated_at": "…" } ]`,
        errors: [{ status: "401 Unauthorized", when: "Auth is enabled, no credential, and public=1 was not given." }],
        examples: { curl: `curl localhost:7420/api/notebooks
curl 'localhost:7420/api/notebooks?public=1'   # published only; no credential needed` },
      },
      {
        method: "POST",
        path: "/api/notebooks",
        summary: "Create a notebook.",
        body: [
          { name: "name", type: "string", desc: "Display name." },
          { name: "cells", type: "json", note: "null", desc: "Any JSON; the console stores an array of NotebookCell objects (see the Notebooks guide)." },
          { name: "public", type: "boolean", note: "false", desc: "Create it already published." },
        ],
        status: "201 Created",
        response: `{ "id": "…", "name": "Sensor analysis", "cells": [], "public": false, "created_at": "…", "updated_at": "…" }`,
        examples: {
          curl: `curl -X POST localhost:7420/api/notebooks -H 'content-type: application/json' -d '{
  "name": "Sensor analysis",
  "cells": [
    {"id": "c1", "kind": "markdown", "code": "## Readings"},
    {"id": "c2", "kind": "sql", "name": "by_sensor", "code": "SELECT sensor, AVG(value) v FROM readings GROUP BY sensor"}
  ]
}'`,
        },
      },
      {
        method: "GET",
        path: "/api/notebooks/{id}",
        summary: "Fetch one notebook.",
        description: "Cells come back with their stored outputs. When the notebook is published this route needs no authentication — it is what the read-only public page loads.",
        params: [{ name: "id", desc: "Notebook UUID." }],
        status: "200 OK",
        response: `{ "id": "…", "name": "…", "cells": [ … ], "public": true, "created_at": "…", "updated_at": "…" }`,
        errors: [
          { status: "404 Not Found", when: "Unknown notebook (authenticated callers, or auth disabled)." },
          { status: "401 Unauthorized", when: "Auth is enabled, no credential, and the notebook is not published — or does not exist; the two are deliberately indistinguishable." },
        ],
        examples: { curl: `curl localhost:7420/api/notebooks/$NB` },
      },
      {
        method: "PUT",
        path: "/api/notebooks/{id}",
        summary: "Replace a notebook's name and cells.",
        params: [{ name: "id", desc: "Notebook UUID." }],
        body: [
          { name: "name", type: "string", desc: "Display name." },
          { name: "cells", type: "json", note: "null", desc: "Full cell array; the server does not merge." },
          { name: "public", type: "boolean", note: "unchanged", desc: "Publish or unpublish in the same write. Omit it to keep the current value." },
        ],
        status: "200 OK",
        response: `{ "id": "…", "name": "…", "cells": [ … ], "public": false, "created_at": "…", "updated_at": "…" }`,
        errors: [{ status: "404 Not Found", when: "Unknown notebook." }],
        examples: { curl: `curl -X PUT localhost:7420/api/notebooks/$NB -H 'content-type: application/json' -d @notebook.json` },
      },
      {
        method: "DELETE",
        path: "/api/notebooks/{id}",
        summary: "Delete a notebook.",
        params: [{ name: "id", desc: "Notebook UUID." }],
        status: "204 No Content",
        response: `(empty body)`,
        responseLang: "plain",
        errors: [{ status: "404 Not Found", when: "Unknown notebook." }],
        examples: { curl: `curl -X DELETE localhost:7420/api/notebooks/$NB` },
      },
      {
        method: "POST",
        path: "/api/notebooks/{id}/publish",
        summary: "Publish: make the notebook readable without authentication.",
        description: "Anyone with the id can then GET the notebook — cell sources and stored outputs — and open it read-only in the console at /notebooks/{id}. It grants nothing else: execution, queries, and writes stay protected. Idempotent; updated_at is not touched. No request body.",
        params: [{ name: "id", desc: "Notebook UUID." }],
        status: "200 OK",
        response: `{ "id": "…", "name": "…", "cells": [ … ], "public": true, "created_at": "…", "updated_at": "…" }`,
        errors: [{ status: "404 Not Found", when: "Unknown notebook." }],
        examples: {
          curl: `curl -X POST localhost:7420/api/notebooks/$NB/publish -H "authorization: Bearer $LOOM_PASSWORD"
curl localhost:7420/api/notebooks/$NB        # now works with no credential`,
        },
      },
      {
        method: "POST",
        path: "/api/notebooks/{id}/unpublish",
        summary: "Unpublish: require authentication again.",
        description: "Takes effect immediately; anonymous reads go back to 401. Idempotent. No request body.",
        params: [{ name: "id", desc: "Notebook UUID." }],
        status: "200 OK",
        response: `{ "id": "…", "name": "…", "cells": [ … ], "public": false, "created_at": "…", "updated_at": "…" }`,
        errors: [{ status: "404 Not Found", when: "Unknown notebook." }],
        examples: { curl: `curl -X POST localhost:7420/api/notebooks/$NB/unpublish -H "authorization: Bearer $LOOM_PASSWORD"` },
      },
    ],
  },
  {
    id: "mcp",
    title: "MCP",
    routes: [
      {
        method: "POST",
        path: "/mcp",
        summary: "Model Context Protocol endpoint (streamable HTTP, stateless).",
        description: "One JSON-RPC message per request, plain JSON back. Methods: initialize, ping, tools/list, tools/call. Notifications (no id) are acknowledged with 202 and no body. Mounted outside /api. With LOOM_PASSWORD set it requires Authorization: Bearer <password> like the REST routes. See the MCP server page for every tool.",
        bodyNote: "A JSON-RPC 2.0 request object.",
        status: "200 OK",
        response: `{ "jsonrpc": "2.0", "id": 1, "result": { "tools": [ … ] } }

// unknown method
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "method not found: foo" } }`,
        examples: {
          curl: `curl -X POST localhost:7420/mcp -H 'content-type: application/json' \\
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'`,
        },
      },
    ],
  },
];

export const ALL_ROUTES = ROUTE_GROUPS.flatMap((g) => g.routes);
