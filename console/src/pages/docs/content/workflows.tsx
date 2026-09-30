import { C, Callout, Code, DocLink, Examples, Fields, H2, H3, Li, P, Table, Ul } from "../primitives";

export default (
  <>
    <H2 id="spec">The WorkflowSpec</H2>
    <P>
      A workflow is created from a <C>WorkflowSpec</C> (<C>POST /api/workflows</C>) and stored with a UUID. Updating replaces the whole spec (<C>PUT</C>). The SDKs' <C>deploy</C> and the MCP <C>create_workflow</C> tool upsert by name on top of these routes.
    </P>
    <Fields
      rows={[
        { name: "name", type: "string", desc: "Display name. Also the key the SDKs and MCP use for upserts." },
        { name: "description", type: "string | null", note: "null", desc: "Free text." },
        { name: "params", type: "json", note: "null", desc: "Default run parameters. Trigger params are merged over them (see below)." },
        { name: "tasks", type: "TaskSpec[]", desc: "The DAG — at least one task." },
        { name: "triggers.every_secs", type: "integer", note: "unset", desc: "Fire a run every N seconds (must be > 0)." },
        { name: "triggers.on_ingest", type: "string", note: "unset", desc: "Fire a run after every ingest into this dataset." },
        { name: "max_parallel_tasks", type: "integer", note: "8", desc: "Maximum tasks executing concurrently within one run. 0 is treated as 1." },
      ]}
    />

    <H3 id="tasks">TaskSpec</H3>
    <Fields
      rows={[
        { name: "id", type: "string", desc: "Unique within the workflow. Other tasks reference it in depends_on and receive this task's result as inputs[id]." },
        { name: "name", type: "string | null", note: "null", desc: "Display name; the task id when unset." },
        { name: "runtime", type: '"python" | "typescript" | "javascript"', desc: "Which worker runs the code." },
        { name: "code", type: "string", desc: "Module source that defines (Python) or exports (JS/TS) handler(params, inputs)." },
        { name: "depends_on", type: "string[]", note: "[]", desc: "Task ids this task consumes. Determines scheduling layers and the keys of inputs." },
        { name: "params", type: "json", note: "null", desc: "Static parameters merged over the run params for this task only." },
        { name: "timeout_secs", type: "integer", note: "300", desc: "Kill the worker (and fail the attempt) after this long." },
        { name: "retries", type: "integer", note: "0", desc: "Extra attempts after the first failure; retries + 1 attempts in total." },
      ]}
    />

    <H3 id="validation">DAG validation</H3>
    <P>Create and update reject an invalid graph with <C>400 {`{"error": "invalid workflow DAG: …"}`}</C>:</P>
    <Table
      head={["Check", "Error message"]}
      rows={[
        ["No tasks", <C key="e">workflow has no tasks</C>],
        ["Repeated id", <C key="e">duplicate task id `a`</C>],
        ["Dependency on a missing id", <C key="e">task `b` depends on unknown task `ghost`</C>],
        ["A task depending on itself", <C key="e">task `a` depends on itself</C>],
        ["A cycle", <C key="e">dependency cycle involving tasks: ["a", "b"]</C>],
      ]}
    />

    <H2 id="handler">handler(params, inputs)</H2>
    <P>Every task, function, and notebook cell is a module with one entrypoint. The two arguments are plain JSON values; the return value must be JSON-serialisable and becomes the task's <C>result</C>.</P>
    <Examples
      title="A task in each runtime"
      examples={{
        python: `# runtime: python — stdout lines stream to the run's logs
def handler(params, inputs):
    # params: run params merged with this task's params
    # inputs: {upstream_task_id: its_result} for every id in depends_on
    print("extracting", params["n"], "items")
    return {"values": list(range(params["n"]))}`,
        typescript: `// runtime: typescript (Node 22 type stripping) — console.* streams to the logs
export async function handler(params: { n: number }, inputs: Record<string, unknown>) {
  console.log("extracting", params.n, "items");
  return { values: Array.from({ length: params.n }, (_, i) => i) };
}`,
      }}
    />
    <Ul>
      <Li>
        <strong>params</strong> — see <DocLink to="/docs/workflows#params">parameter merging</DocLink> below.
      </Li>
      <Li>
        <strong>inputs</strong> — an object keyed by upstream task id: <C>{`{"extract": {"values": [...]}}`}</C>. Only ids listed in <C>depends_on</C> appear. Functions and direct <C>/api/execute</C> calls receive whatever <C>inputs</C> the caller sent (functions: <C>null</C>).
      </Li>
      <Li>
        <strong>Logs</strong> — Python <C>print()</C> and Node <C>console.*</C> lines are streamed live as <C>log</C> events and stored on the task run. A raised exception fails the attempt; its message becomes the task's <C>error</C> and the traceback is appended to the logs as <C>[trace]</C> lines.
      </Li>
      <Li>
        <strong>Self-contained</strong> — each job loads as a fresh module in a worker process. Put imports inside the module, do not rely on captured variables (the SDKs serialise function source), and expect only the standard library plus whatever is installed for <C>LOOM_PYTHON_BIN</C> / <C>LOOM_NODE_BIN</C>.
      </Li>
    </Ul>

    <H3 id="platform-bindings">Platform bindings inside a task</H3>
    <P>
      Every worker can reach back into the platform over <C>LOOM_API_URL</C>: <C>import loom</C> in Python, or the pre-installed <C>loom</C> global in JavaScript/TypeScript. Both expose the same three calls. Python calls bypass any configured HTTP proxy.
    </P>
    <Table
      head={["Call", "Does", "Returns"]}
      rows={[
        [<C key="q">loom.query(sql, limit=10000)</C>, <>POST /api/query on the embedded engine (no connector option).</>, "The rows array."],
        [<C key="i">loom.ingest(dataset, records)</C>, <>Streams an iterable of records as NDJSON to POST /api/ingest/{"{dataset}"}.</>, <>The ingest response (<C>dataset</C>, <C>ingested</C>, <C>triggered_runs</C>).</>],
        [<C key="v">loom.invoke(name, params={})</C>, <>POST /api/functions/{"{name}"}/invoke.</>, <>The invoke response (<C>ok</C>, <C>result</C>, …).</>],
      ]}
    />
    <Examples
      examples={{
        python: `import loom

def handler(params, inputs):
    rows = loom.query("SELECT sensor, AVG(value) AS v FROM readings GROUP BY sensor")
    loom.ingest("aggregates", rows)
    return loom.invoke("notify", {"count": len(rows)})`,
        typescript: `export async function handler(params: any, inputs: any) {
  const rows = await loom.query("SELECT sensor, AVG(value) AS v FROM readings GROUP BY sensor");
  await loom.ingest("aggregates", rows);
  return loom.invoke("notify", { count: rows.length });
}`,
      }}
    />

    <H2 id="params">Parameter merging</H2>
    <P>
      Parameters are merged twice with the same rule, <C>merge_params(base, overlay)</C>: when both sides are objects they merge key by key and the overlay wins; a <C>null</C> (or absent) overlay keeps the base; anything else replaces the base wholesale. The merge is shallow — nested objects are replaced, not merged.
    </P>
    <Code
      lang="plain"
      title="Order of precedence"
      code={`run.params  = merge(workflow.spec.params, trigger params)   # at launch
task params = merge(run.params,           task.params)      # per task, at execution`}
    />
    <Code
      lang="json"
      title="Example"
      code={`// workflow.params
{ "n": 100, "region": "eu", "opts": { "a": 1, "b": 2 } }
// trigger body params
{ "n": 5, "opts": { "a": 9 } }
// → run.params (opts replaced, not deep-merged)
{ "n": 5, "region": "eu", "opts": { "a": 9 } }
// task.params for "extract": { "region": "us" }
// → handler params for "extract"
{ "n": 5, "region": "us", "opts": { "a": 9 } }`}
    />
    <P>
      Scheduled runs pass <C>null</C>, so they see exactly the workflow params. Ingest-triggered runs pass <C>{`{"dataset", "records", "bytes", "path"}`}</C>, which therefore overrides workflow keys with the same names.
    </P>

    <H2 id="scheduling">Scheduling and parallelism</H2>
    <P>
      At launch the orchestrator groups tasks into layers with Kahn's algorithm: every task in layer N depends only on tasks in earlier layers. Layers run in order; within a layer all tasks are started concurrently, bounded by <C>max_parallel_tasks</C>. A task's <C>inputs</C> is assembled from the results of its <C>depends_on</C> ids just before it starts.
    </P>
    <Code
      lang="json"
      title="A diamond: b and c run in parallel"
      code={`{
  "name": "diamond",
  "max_parallel_tasks": 2,
  "tasks": [
    {"id": "a", "runtime": "python", "code": "def handler(p, i):\\n    return 1\\n"},
    {"id": "b", "runtime": "python", "depends_on": ["a"], "code": "def handler(p, i):\\n    return i['a'] + 1\\n"},
    {"id": "c", "runtime": "python", "depends_on": ["a"], "code": "def handler(p, i):\\n    return i['a'] * 10\\n"},
    {"id": "d", "runtime": "javascript", "depends_on": ["b", "c"],
     "code": "export const handler = (p, i) => ({ sum: i.b + i.c });\\n"}
  ]
}`}
    />

    <H2 id="retries">Retries, timeouts, and failure</H2>
    <Ul>
      <Li>
        Each attempt gets a fresh worker job and the full <C>timeout_secs</C>. After a failed attempt with retries left, the orchestrator emits a log line <C>attempt 1/3 failed (…); retrying</C> and tries again immediately (no back-off). <C>TaskRun.attempts</C> counts attempts so far.
      </Li>
      <Li>
        A timeout kills the worker and counts as a failed attempt with the error <C>workload timed out after Ns</C>.
      </Li>
      <Li>
        When attempts are exhausted the task is <C>failed</C> and the run finishes as <C>failed</C> with <C>error = "task `id` failed: message"</C>. Other tasks in the same layer complete normally; later layers never start and their tasks are marked <C>cancelled</C>.
      </Li>
      <Li>
        Cancelling a run (<C>POST /api/runs/{"{id}"}/cancel</C>) stops retrying, kills in-flight workers, and marks outstanding tasks <C>cancelled</C> with the error <C>cancelled by user</C>.
      </Li>
    </Ul>

    <H2 id="triggers">Triggers</H2>
    <H3 id="every-secs">Interval: triggers.every_secs</H3>
    <P>
      The scheduler ticks every 2 seconds and launches a run with trigger <C>schedule</C> whenever a workflow's interval is due. Due times are kept in memory and seeded lazily, so after a server restart (or after creating the workflow) the first run happens one full interval later rather than immediately. A workflow that already has a run in progress is still launched again when due — runs do not queue behind each other.
    </P>
    <Examples
      examples={{
        curl: `curl -X POST localhost:7420/api/workflows -H 'content-type: application/json' -d '{
  "name": "heartbeat", "triggers": {"every_secs": 300},
  "tasks": [{"id": "ping", "runtime": "python", "code": "def handler(p, i):\\n    return \\"ok\\"\\n"}]
}'`,
        python: `client.deploy(Flow("heartbeat", tasks=[ping], every_secs=300))`,
        typescript: `await client.deploy(flow("heartbeat", [ping], { everySecs: 300 }));`,
      }}
    />

    <H3 id="on-ingest">Data-driven: triggers.on_ingest</H3>
    <P>
      After every <C>POST /api/ingest/{"{dataset}"}</C> batch is fully persisted, each workflow whose <C>on_ingest</C> equals that dataset name is launched with trigger <C>ingest:&lt;dataset&gt;</C>. The run params carry the batch's metadata — not the records — so the task reads the file itself or queries the dataset:
    </P>
    <Code lang="json" code={`{ "dataset": "sensor-batch", "records": 5000, "bytes": 231000, "path": "/srv/loom/data/datasets/sensor-batch.ndjson" }`} />
    <Examples
      examples={{
        python: `from loom_sdk import LoomClient, Flow, task

@task
def load_batch(params, inputs):
    import json
    with open(params["path"]) as f:          # the whole dataset file, not just this batch
        rows = [json.loads(line) for line in f]
    return {"n": len(rows)}

client = LoomClient()
client.deploy(Flow("sensor-stats", tasks=[load_batch], on_ingest="sensor-batch"))
res = client.ingest("sensor-batch", ({"sensor": i % 16, "value": i} for i in range(5000)))
print(res["triggered_runs"])                  # ["<run id>"]`,
        typescript: `await client.deploy(flow("sensor-stats", [loadBatch], { onIngest: "sensor-batch" }));
const res = await client.ingest("sensor-batch", rows);
console.log((res as { triggered_runs: string[] }).triggered_runs);`,
      }}
    />
    <Callout kind="note" title="The ingest response lists the runs it started">
      <C>triggered_runs</C> in the ingest response contains the ids of every run launched by the batch, so a caller can stream them immediately. The MCP <C>ingest</C> tool writes the file directly and does not launch these workflows.
    </Callout>

    <H2 id="console">Editing in the console</H2>
    <P>
      The Workflows page builds the same spec with a structured form and a JSON tab; the editor offers <C>params</C> / <C>inputs</C> autocomplete based on upstream tasks' last results, and the workflow detail page renders the DAG with live task state and a per-run Gantt timeline.
    </P>
  </>
);
