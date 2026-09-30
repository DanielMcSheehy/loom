import { C, Callout, Code, DocLink, Examples, H2, Li, Ol, P, Ul } from "../primitives";

export default (
  <>
    <H2 id="requirements">Requirements</H2>
    <Ul>
      <Li>Rust 1.80+ to build the server.</Li>
      <Li>Python 3.10+ on the server host for Python tasks (<C>python3</C> on PATH, or set <C>LOOM_PYTHON_BIN</C>).</Li>
      <Li>Node 20+ for JavaScript tasks, Node 22+ for TypeScript tasks (<C>node</C> on PATH, or set <C>LOOM_NODE_BIN</C>).</Li>
    </Ul>

    <H2 id="run-the-server">1. Run the server</H2>
    <Code
      lang="bash"
      code={`# API on :7420; data in ./data
cargo run --release -p loom-server

# build the console once, then restart — the server serves console/dist itself
cd console && npm install && npm run build && cd ..

# or, for console development with hot reload (proxies /api to :7420):
cd console && npm run dev`}
    />
    <P>
      With Docker: <C>docker compose up --build</C> brings everything up on <C>http://localhost:7420</C>. Every setting is an environment variable; see <DocLink to="/docs/configuration">Configuration</DocLink>.
    </P>
    <Code lang="bash" code={`curl localhost:7420/api/healthz
# {"ok":true,"service":"loom-server"}`} />

    <H2 id="first-workflow">2. Create a workflow</H2>
    <P>
      A workflow is JSON: a name, optional default <C>params</C>, and a list of tasks. Each task is a module that defines <C>handler(params, inputs)</C>. Here a Python task produces a list and a TypeScript task sums it — results cross language boundaries as JSON.
    </P>
    <Examples
      examples={{
        curl: `curl -X POST localhost:7420/api/workflows -H 'content-type: application/json' -d '{
  "name": "hello-pipeline",
  "params": {"n": 100},
  "tasks": [
    {"id": "extract", "runtime": "python",
     "code": "def handler(params, inputs):\\n    return {\\"values\\": list(range(params[\\"n\\"]))}\\n"},
    {"id": "total", "runtime": "typescript", "depends_on": ["extract"],
     "code": "export function handler(params: any, inputs: any) {\\n  return inputs.extract.values.reduce((a: number, b: number) => a + b, 0);\\n}\\n"}
  ]
}'
# → 201 {"id": "<workflow id>", "spec": {...}, ...}`,
        python: `# pip install -e sdks/python
from loom_sdk import LoomClient, Flow, task

@task
def extract(params, inputs):
    return {"values": list(range(params["n"]))}

@task(depends_on=[extract])
def total(params, inputs):
    return sum(inputs["extract"]["values"])

client = LoomClient("http://localhost:7420")
wf = client.deploy(Flow("hello-pipeline", params={"n": 100}, tasks=[extract, total]))
print(wf["id"])`,
        typescript: `// cd sdks/typescript && npm install && npm run build
import { LoomClient, flow, task } from "@loom/sdk";

const extract = task("extract", async (params) => ({
  values: Array.from({ length: params.n as number }, (_, i) => i),
}));
const total = task(
  "total",
  async (_params, inputs) => (inputs.extract as { values: number[] }).values.reduce((a, b) => a + b, 0),
  { dependsOn: [extract] },
);

const client = new LoomClient("http://localhost:7420");
const wf = await client.deploy(flow("hello-pipeline", [extract, total], { params: { n: 100 } }));
console.log(wf.id);`,
      }}
    />

    <H2 id="trigger-a-run">3. Trigger a run and read the result</H2>
    <Examples
      examples={{
        curl: `WF=<workflow id>
RUN=$(curl -s -X POST localhost:7420/api/workflows/$WF/trigger \\
  -H 'content-type: application/json' -d '{"params": {"n": 10}}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

curl -s localhost:7420/api/runs/$RUN | python3 -m json.tool
# "run": {"state": "completed", ...}
# "tasks": [..., {"task_id": "total", "result": 45, "logs": [...]}]`,
        python: `run = client.trigger(wf["id"], params={"n": 10}, wait=True)
print(run["state"])                                  # "completed"
tasks = client.get_run(run["id"])["tasks"]
print({t["task_id"]: t["result"] for t in tasks})    # {"extract": {...}, "total": 45}`,
        typescript: `const run = await client.trigger(wf.id, { params: { n: 10 }, wait: true });
console.log(run.state); // "completed"
const { tasks } = await client.getRun(run.id);
console.log(tasks.find((t) => t.task_id === "total")?.result); // 45`,
      }}
    />

    <H2 id="watch-it-live">4. Watch it live</H2>
    <P>Every state change and log line is broadcast as a server-sent event. The console's Runs page is a subscriber to the same stream.</P>
    <Examples
      examples={{
        curl: `curl -N localhost:7420/api/events
# data: {"type":"run_updated","ts":"…","run":{"state":"running",…}}
# data: {"type":"task_updated","ts":"…","task":{"task_id":"extract","state":"completed",…}}
# data: {"type":"log","ts":"…","run_id":"…","task_id":"total","line":"…"}`,
        python: `run = client.trigger(wf["id"])
for event in client.stream_run(run["id"]):       # returns after the terminal run_updated
    print(event["type"], event.get("line", ""))`,
        typescript: `const run = await client.trigger(wf.id);
for await (const event of client.streamRun(run.id)) {
  if (event.type === "log") console.log(event.line);
}`,
      }}
    />

    <H2 id="next">Where next</H2>
    <Ol>
      <Li>
        <DocLink to="/docs/workflows">Workflows & DAGs</DocLink> — parameter merging, retries, timeouts, and scheduled or data-driven triggers.
      </Li>
      <Li>
        <DocLink to="/docs/data">Data ingest</DocLink> and <DocLink to="/docs/sql">SQL</DocLink> — stream NDJSON in, query it with Polars from anywhere, including inside tasks via <C>loom.query()</C>.
      </Li>
      <Li>
        <DocLink to="/docs/notebooks">Notebooks</DocLink> — explore data interactively in the console with chained cells and charts.
      </Li>
      <Li>
        <DocLink to="/docs/mcp">MCP server</DocLink> — let an AI agent drive all of this: <C>claude mcp add --transport http loom http://localhost:7420/mcp</C>.
      </Li>
    </Ol>
    <Callout kind="note" title="Runnable examples in the repository">
      <C>examples/python_pipeline.py</C> deploys an ingest-triggered flow, streams 5,000 records, and follows the run live; <C>examples/typescript_pipeline.mts</C> does the same from Node with a Python task in the middle of a TypeScript flow.
    </Callout>
  </>
);
