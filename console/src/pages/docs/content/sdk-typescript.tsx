import { C, Callout, Code, DocLink, H2, H3, Li, P, Table, Ul } from "../primitives";

export default (
  <>
    <H2 id="install">Install</H2>
    <Code
      lang="bash"
      code={`cd sdks/typescript && npm install && npm run build      # emits dist/index.js + types
# import { LoomClient, flow, task } from "@loom/sdk";   (or from "../sdks/typescript/dist/index.js")`}
    />
    <P>Zero runtime dependencies: everything is built on global <C>fetch</C> and <C>ReadableStream</C> (Node 20+, Bun, Deno, browsers).</P>

    <H2 id="define">Define tasks and flows</H2>
    <Code
      lang="typescript"
      code={`import { LoomClient, flow, task } from "@loom/sdk";

// a handler function — serialized with Function.prototype.toString() and run as "javascript"
const extract = task("extract", async (params) => ({
  values: Array.from({ length: params.n as number }, (_, i) => i),
}));

const total = task(
  "total",
  async (_params, inputs) =>
    (inputs.extract as { values: number[] }).values.reduce((a, b) => a + b, 0),
  { dependsOn: [extract], retries: 2, timeoutSecs: 60 },
);

// raw source in another runtime
const crunch = task("crunch", {
  runtime: "python",
  code: "def handler(params, inputs):\\n    return len(inputs['extract']['values'])\\n",
}, { dependsOn: [extract] });

const spec = flow("sum-pipeline", [extract, total, crunch], { params: { n: 100 } });`}
    />
    <H3 id="task">task(id, handler | {"{ runtime, code }"}, options?)</H3>
    <P>
      Function handlers must be self-contained: the source text is what runs on the server, so captured variables and imports outside the function are not available. Handlers may be <C>async</C>. When Node 22+ strips type annotations from a typed handler it leaves equal-width gaps in <C>toString()</C> output; the SDK collapses those gaps before deploy so the stored source stays readable.
    </P>
    <Table
      head={["Option", "Default", "Meaning"]}
      rows={[
        [<C key="d">dependsOn</C>, "[]", "Task ids or TaskSpec objects."],
        [<C key="p">params</C>, "{}", "Static task params."],
        [<C key="t">timeoutSecs</C>, "300", "Per attempt."],
        [<C key="r">retries</C>, "0", "Extra attempts."],
        [<C key="ru">runtime</C>, '"javascript"', 'For function handlers; set "typescript" to keep type annotations in the shipped source.'],
      ]}
    />
    <H3 id="flow">flow(name, tasks, options?)</H3>
    <Table
      head={["Option", "Default", "Meaning"]}
      rows={[
        [<C key="de">description</C>, "null", "Free text."],
        [<C key="pa">params</C>, "{}", "Default run params."],
        [<C key="ev">everySecs</C>, "unset", "Interval trigger."],
        [<C key="on">onIngest</C>, "unset", "Dataset-triggered."],
        [<C key="mp">maxParallelTasks</C>, "8", "Concurrency cap per run."],
      ]}
    />
    <P>
      <C>flow()</C> returns a plain <C>WorkflowSpec</C> — the exact JSON the server accepts — so it can be logged, stored, or posted by any client.
    </P>

    <H2 id="client">LoomClient</H2>
    <Code
      lang="typescript"
      code={`import { LoomClient, LoomError } from "@loom/sdk";

const client = new LoomClient("http://localhost:7420");     // default
const wf = await client.deploy(spec);                        // POST, or PUT when the name exists
const run = await client.trigger(wf.id, { params: { n: 10 }, wait: true, pollMs: 500 });
console.log(run.state);                                      // "completed"

try {
  await client.cancelRun(run.id);
} catch (e) {
  if (e instanceof LoomError) console.log(e.status, e.message);   // 409 "HTTP 409: run is already completed"
}`}
    />
    <P>
      For a server started with <C>LOOM_PASSWORD</C>, pass the password as <C>token</C> — <C>{`new LoomClient(url, { token })`}</C> — or set <C>LOOM_API_TOKEN</C>, which the client reads by default wherever <C>process.env</C> exists. It is sent as <C>Authorization: Bearer</C> on every request, event streams included; without it the server answers <C>401</C>.
    </P>
    <P>
      Every non-2xx response rejects with <C>LoomError</C> (<C>status</C>, and a message built from the server's <C>{`{"error"}`}</C>). All methods are typed; the exported types include <C>WorkflowSpec</C>, <C>TaskSpec</C>, <C>Workflow</C>, <C>Run</C>, <C>TaskRun</C>, <C>RunState</C>, <C>LoomEvent</C>, <C>ColumnProfile</C>, <C>DatasetProfile</C>, and <C>Json</C>.
    </P>
    <Table
      head={["Method", "Calls", "Resolves to"]}
      rows={[
        [<C key="m">deploy(spec)</C>, "GET /api/workflows, then POST or PUT /api/workflows/{id}", "Workflow"],
        [<C key="m">listWorkflows()</C>, "GET /api/workflows", "Workflow[]"],
        [<C key="m">getWorkflow(id)</C>, "GET /api/workflows/{id}", "Workflow"],
        [<C key="m">deleteWorkflow(id)</C>, "DELETE /api/workflows/{id}", "void"],
        [<C key="m">trigger(id, {`{ params?, wait?, pollMs? }`})</C>, "POST /api/workflows/{id}/trigger (+ GET /api/runs/{id} while waiting)", "Run (final run when waiting; no timeout)"],
        [<C key="m">listRuns({`{ workflowId?, limit? }`})</C>, "GET /api/runs", "Run[]"],
        [<C key="m">getRun(id)</C>, "GET /api/runs/{id}", <C key="r">{`{ run, tasks }`}</C>],
        [<C key="m">cancelRun(id)</C>, "POST /api/runs/{id}/cancel", "Run; LoomError 409 if finished"],
        [<C key="m">createFunction({`{ name, code, runtime?, description?, timeoutSecs? }`})</C>, "POST /api/functions (runtime defaults to javascript)", "Function JSON"],
        [<C key="m">invoke(name, params?)</C>, "POST /api/functions/{name}/invoke", <C key="r">{`{ ok, result?, error?, logs?, duration_ms }`}</C>],
        [<C key="m">deleteFunction(name)</C>, "DELETE /api/functions/{name}", "void"],
        [<C key="m">ingest(dataset, records)</C>, "POST /api/ingest/{dataset} (NDJSON from any iterable)", "Ingest response"],
        [<C key="m">listDatasets()</C>, "GET /api/datasets", "Dataset[] (typed as Json)"],
        [<C key="m">describeDataset(name, {`{ sample? }`})</C>, "GET /api/datasets/{name}?sample=", "DatasetProfile"],
        [<C key="m">deleteDataset(name)</C>, "DELETE /api/datasets/{name}", "void"],
        [<C key="m">query(sql, {`{ limit?, connector? }`})</C>, "POST /api/query", "The rows array"],
        [<C key="m">execute({`{ code, runtime?, params?, inputs?, timeoutSecs? }`})</C>, "POST /api/execute (runtime defaults to python)", <C key="r">{`{ ok, result?, logs?, error?, duration_ms }`}</C>],
        [<C key="m">stats()</C>, "GET /api/stats", "Stats JSON"],
        [<C key="m">events(runId?, signal?)</C>, "GET /api/events or /api/runs/{id}/events (SSE)", "AsyncGenerator<LoomEvent>"],
        [<C key="m">streamRun(runId)</C>, "GET /api/runs/{id}/events + GET /api/runs/{id}", "AsyncGenerator that ends at the terminal run_updated"],
      ]}
    />

    <H2 id="recipes">Recipes</H2>
    <H3 id="stream">Stream a run live</H3>
    <Code
      lang="typescript"
      code={`const run = await client.trigger(wf.id);
for await (const ev of client.streamRun(run.id)) {
  if (ev.type === "log") console.log(\`[\${ev.task_id}] \${ev.line}\`);
  if (ev.type === "run_updated") console.log("run:", (ev.run as { state: string }).state);
}
const { tasks } = await client.getRun(run.id);
console.log(tasks.find((t) => t.task_id === "total")?.result);`}
    />
    <H3 id="functions">Functions</H3>
    <Code
      lang="typescript"
      code={`await client.createFunction({
  name: "hello",
  code: 'export const handler = (params) => \`hi \${params.name}\`;',   // runtime: javascript
});
const { ok, result } = await client.invoke("hello", { name: "loom" });`}
    />
    <H3 id="data">Ingest, profile, query</H3>
    <Code
      lang="typescript"
      code={`await client.ingest("sensor-readings", [{ sensor: "a", v: 1 }, { sensor: "b", v: 2 }]);
const profile = await client.describeDataset("sensor-readings", { sample: 5 });
console.log(profile.columns);   // [{ name: "sensor", dtype: "string", ... }, { name: "v", dtype: "integer", min: 1, max: 2, mean: 1.5, ... }]
const rows = await client.query("SELECT sensor, SUM(v) AS total FROM sensor_readings GROUP BY sensor");
await client.deleteDataset("sensor-readings");`}
    />
    <Ul>
      <Li>
        Full runnable version, with a Python task inside a TypeScript flow: <C>examples/typescript_pipeline.mts</C>.
      </Li>
      <Li>
        Route details for every call: <DocLink to="/docs/api">REST API reference</DocLink>.
      </Li>
    </Ul>
    <Callout kind="note" title="Not wrapped">
      Listing functions, connectors, notebooks, and the streaming function invoke have no client methods; call those routes with <C>fetch</C> directly.
    </Callout>
  </>
);
