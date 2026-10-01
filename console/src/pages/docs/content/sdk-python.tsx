import { C, Callout, Code, DocLink, H2, H3, Li, P, Table, Ul } from "../primitives";

export default (
  <>
    <H2 id="install">Install</H2>
    <Code
      lang="bash"
      code={`pip install -e sdks/python          # package: loom-sdk, module: loom_sdk
# or run scripts from the repo root with sys.path pointing at sdks/python (see examples/)`}
    />
    <P>The SDK is standard library only (<C>urllib</C>, <C>json</C>): nothing else to install.</P>

    <H2 id="define">Define tasks and flows</H2>
    <Code
      lang="python"
      code={`from loom_sdk import LoomClient, Flow, Task, task

@task                                    # id defaults to the function name
def extract(params, inputs):
    import json                          # imports go inside: the function is shipped as source
    print("pulling", params["n"], "records")
    return {"values": list(range(params["n"]))}

@task(depends_on=[extract], retries=2, timeout_secs=60)
def total(params, inputs):
    return sum(inputs["extract"]["values"])

# a raw task in another runtime
shape = Task(
    id="shape", runtime="typescript", depends_on=["total"],
    code="export const handler = (p: any, i: any) => ({ report: \`total=\${i.total}\` });\\n",
)

flow = Flow("sum-pipeline", params={"n": 100}, tasks=[extract, total, shape])`}
    />
    <H3 id="task-decorator">@task</H3>
    <P>
      Usable bare or with options. The decorated function still works as a normal callable and gains a <C>.loom_task</C> attribute holding its <C>Task</C>. The function's source is extracted with <C>inspect.getsource</C>, decorator lines are stripped, and <C>handler = &lt;name&gt;</C> is appended — so the body must be self-contained (do imports inside, no closures over module state).
    </P>
    <Table
      head={["Option", "Default", "Meaning"]}
      rows={[
        [<C key="i">id</C>, "function name", "Task id (the key in downstream inputs)."],
        [<C key="d">depends_on</C>, "()", "Task ids, Task objects, or @task functions."],
        [<C key="p">params</C>, "{}", "Static task params merged over run params."],
        [<C key="t">timeout_secs</C>, "300", "Per attempt."],
        [<C key="r">retries</C>, "0", "Extra attempts."],
      ]}
    />
    <H3 id="flow">Flow and Task</H3>
    <Table
      head={["Constructor argument", "Default", "Meaning"]}
      rows={[
        [<C key="n">Flow(name, …)</C>, "required", "Workflow name; deploy upserts on it."],
        [<C key="de">description</C>, "None", "Free text."],
        [<C key="pa">params</C>, "{}", "Default run params."],
        [<C key="ta">tasks</C>, "()", "Task objects or @task functions; Flow.add(t, **overrides) appends one more."],
        [<C key="ev">every_secs</C>, "None", "Interval trigger."],
        [<C key="on">on_ingest</C>, "None", "Dataset-triggered."],
        [<C key="mp">max_parallel_tasks</C>, "8", "Concurrency cap per run."],
        [<C key="tk">Task(id, code, runtime="python", depends_on, params, timeout_secs, retries, name)</C>, "", "A task from raw source in any runtime."],
      ]}
    />
    <P>
      <C>flow.spec()</C> returns the exact JSON sent to the server, handy for inspection or for posting with another client.
    </P>

    <H2 id="client">LoomClient</H2>
    <Code
      lang="python"
      code={`from loom_sdk import LoomClient, LoomError

client = LoomClient("http://localhost:7420", timeout=30.0)   # both defaults
wf = client.deploy(flow)                                     # POST, or PUT when the name exists
run = client.trigger(wf["id"], params={"n": 10}, wait=True)  # polls every 0.5 s, up to 3600 s
print(run["state"], client.get_run(run["id"])["tasks"][-1]["result"])`}
    />
    <P>
      For a server started with <C>LOOM_PASSWORD</C>, pass the password as <C>token</C> — <C>LoomClient(url, token="…")</C> — or export <C>LOOM_API_TOKEN</C>, which the client reads by default. It is sent as <C>Authorization: Bearer</C> on every request, event streams included; without it the server answers <C>401</C>.
    </P>
    <P>
      Every non-2xx response raises <C>LoomError(status, message)</C> with the server's <C>{`{"error"}`}</C> text; <C>e.status</C> holds the HTTP code. <C>trigger(wait=True)</C> raises <C>TimeoutError</C> if the run is not terminal within <C>timeout</C>.
    </P>
    <Table
      head={["Method", "Calls", "Returns"]}
      rows={[
        [<C key="m">deploy(flow)</C>, "GET /api/workflows, then POST or PUT /api/workflows/{id}", "Workflow dict"],
        [<C key="m">list_workflows()</C>, "GET /api/workflows", "list"],
        [<C key="m">get_workflow(id)</C>, "GET /api/workflows/{id}", "Workflow dict"],
        [<C key="m">delete_workflow(id)</C>, "DELETE /api/workflows/{id}", "None"],
        [<C key="m">trigger(id, params=None, wait=False, poll_interval=0.5, timeout=3600.0)</C>, "POST /api/workflows/{id}/trigger (+ GET /api/runs/{id} while waiting)", "Run dict (the final run when waiting)"],
        [<C key="m">list_runs(workflow_id=None, limit=50)</C>, "GET /api/runs", "list"],
        [<C key="m">get_run(run_id)</C>, "GET /api/runs/{id}", <C key="r">{`{"run", "tasks"}`}</C>],
        [<C key="m">cancel_run(run_id)</C>, "POST /api/runs/{id}/cancel", "Run dict; LoomError 409 if finished"],
        [<C key="m">create_function(name, code, runtime="python", description=None, timeout_secs=300)</C>, "POST /api/functions", "Function dict"],
        [<C key="m">list_functions()</C>, "GET /api/functions", "list"],
        [<C key="m">invoke(name, params=None)</C>, "POST /api/functions/{name}/invoke", <C key="r">{`{"ok", "result", "logs", "duration_ms"}`}</C>],
        [<C key="m">delete_function(name)</C>, "DELETE /api/functions/{name}", "None"],
        [<C key="m">ingest(dataset, records)</C>, "POST /api/ingest/{dataset} (NDJSON built from any iterable)", "Ingest response dict"],
        [<C key="m">list_datasets()</C>, "GET /api/datasets", "list"],
        [<C key="m">describe_dataset(name, sample=20)</C>, "GET /api/datasets/{name}?sample=", "Profile dict"],
        [<C key="m">delete_dataset(name)</C>, "DELETE /api/datasets/{name}", "None"],
        [<C key="m">query(sql, limit=10000, connector=None)</C>, "POST /api/query", "The rows list"],
        [<C key="m">execute(code, runtime="python", params=None, inputs=None, timeout_secs=120)</C>, "POST /api/execute", <span key="r"><C>{`{"ok", "result", "logs", "duration_ms"}`}</C> or error/trace</span>],
        [<C key="m">events(run_id=None)</C>, "GET /api/events or /api/runs/{id}/events (SSE)", "Iterator of event dicts; blocks"],
        [<C key="m">stream_run(run_id)</C>, "GET /api/runs/{id}/events + GET /api/runs/{id}", "Iterator that stops at the terminal run_updated"],
        [<C key="m">stats()</C>, "GET /api/stats", "Stats dict"],
      ]}
    />

    <H2 id="recipes">Recipes</H2>
    <H3 id="stream">Stream a run live</H3>
    <Code
      lang="python"
      code={`run = client.trigger(wf["id"])
for event in client.stream_run(run["id"]):
    if event["type"] == "log":
        print(f"[{event['task_id']}] {event['line']}")
    elif event["type"] == "run_updated":
        print("run:", event["run"]["state"])`}
    />
    <H3 id="functions">Functions</H3>
    <Code
      lang="python"
      code={`client.create_function("hello", "def handler(params, inputs):\\n    return f\\"hi {params['name']}\\"\\n")
res = client.invoke("hello", {"name": "loom"})       # {"ok": True, "result": "hi loom", "logs": [], "duration_ms": 1}`}
    />
    <H3 id="data">Ingest, profile, query</H3>
    <Code
      lang="python"
      code={`client.ingest("sensor-readings", ({"sensor": i % 8, "v": i * 0.5} for i in range(10_000)))
profile = client.describe_dataset("sensor-readings", sample=5)
print(profile["columns"][1])   # {"name": "v", "dtype": "float", "min": 0.0, "max": 4999.5, "mean": 2499.75, ...}
rows = client.query("SELECT sensor, AVG(v) AS v FROM sensor_readings GROUP BY sensor")
client.delete_dataset("sensor-readings")`}
    />
    <H3 id="ingest-triggered">An ingest-triggered flow</H3>
    <Code
      lang="python"
      code={`@task
def load_batch(params, inputs):
    import json
    with open(params["path"]) as f:                 # trigger params: dataset, records, bytes, path
        rows = [json.loads(line) for line in f]
    return {"n": len(rows)}

wf = client.deploy(Flow("sensor-stats", tasks=[load_batch], on_ingest="sensor-batch"))
res = client.ingest("sensor-batch", ({"value": i} for i in range(5000)))
for event in client.stream_run(res["triggered_runs"][0]):
    ...`}
    />
    <Ul>
      <Li>
        Full runnable version: <C>examples/python_pipeline.py</C>.
      </Li>
      <Li>
        Route details for every call: <DocLink to="/docs/api">REST API reference</DocLink>.
      </Li>
    </Ul>
    <Callout kind="note" title="Not wrapped">
      Connectors, notebooks, and the streaming function invoke have no client methods; call those routes with <C>urllib</C> directly.
    </Callout>
  </>
);
