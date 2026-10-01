import { Link } from "react-router-dom";
import { DOC_PAGES } from "../meta";
import { C, Callout, Code, DocLink, H2, H3, Li, P, Table, Ul } from "../primitives";

const StatePill = ({ s }: { s: string }) => <span className={`pill ${s}`}>{s}</span>;

export default (
  <>
    <H2 id="what-is-loom">What Loom is</H2>
    <P>
      Loom is a Rust-native orchestration platform for Python and TypeScript workloads. One binary runs the HTTP API, the
      orchestrator, an interval scheduler, streaming NDJSON ingestion, an embedded SQL engine (Polars), a serverless function
      runtime, notebook storage, an MCP server for AI agents, and this console. State lives in an embedded SQLite database under{" "}
      <C>LOOM_DATA_DIR</C>; there is no broker and no external database.
    </P>
    <P>
      User code always has the same shape: a module that defines <C>handler(params, inputs)</C>. Workflows run handlers as DAG
      tasks, functions expose one handler over HTTP, notebooks run handlers as cells, and <C>POST /api/execute</C> runs one
      directly. All of them execute in isolated worker processes managed by the executor.
    </P>

    <H2 id="concepts">Core concepts</H2>
    <Table
      head={["Concept", "What it is", "Where"]}
      rows={[
        [<strong key="w">Workflow</strong>, <>A named <C>WorkflowSpec</C>: default params, a list of tasks, triggers, and a concurrency cap. Stored with a UUID.</>, <DocLink key="l" to="/docs/workflows">Workflows & DAGs</DocLink>],
        [<strong key="t">Task</strong>, <>One node of the DAG: an id, a runtime (<C>python</C>, <C>typescript</C>, <C>javascript</C>), code, <C>depends_on</C>, per-task params, a timeout, and a retry count.</>, <DocLink key="l" to="/docs/workflows#tasks">TaskSpec</DocLink>],
        [<strong key="r">Run</strong>, <>One execution of a workflow. Carries the effective params, what triggered it, and a state. Each task gets a <C>TaskRun</C> with attempts, result, error, and logs.</>, <DocLink key="l" to="/docs/runs">Runs & events</DocLink>],
        [<strong key="f">Function</strong>, <>A named handler invoked over HTTP with <C>params</C> only. Upserted by name; invocation count tracked.</>, <DocLink key="l" to="/docs/functions">Functions</DocLink>],
        [<strong key="d">Dataset</strong>, <>An append-only NDJSON file created by ingestion. Every dataset is a SQL table.</>, <DocLink key="l" to="/docs/data">Data ingest</DocLink>],
        [<strong key="c">Connector</strong>, <>A registered Postgres, ClickHouse, or chDB source that <C>/api/query</C> can target instead of the embedded engine.</>, <DocLink key="l" to="/docs/sql#connectors">SQL & connectors</DocLink>],
        [<strong key="n">Notebook</strong>, <>A document of markdown, code, and SQL cells; the console owns the cell schema and chains cell outputs as <C>inputs</C>.</>, <DocLink key="l" to="/docs/notebooks">Notebooks</DocLink>],
        [<strong key="e">Event</strong>, <>Every state change, log line, ingest, and invocation is a <C>LoomEvent</C> broadcast over SSE.</>, <DocLink key="l" to="/docs/runs#events">Event stream</DocLink>],
      ]}
    />

    <H2 id="state-machine">Run and task state machine</H2>
    <P>Runs and task runs share one set of states. Terminal states never transition again.</P>
    <div className="doc-states">
      <StatePill s="pending" />
      <span className="arrow">→</span>
      <StatePill s="running" />
      <span className="arrow">→</span>
      <span className="group">
        <StatePill s="completed" />
        <StatePill s="failed" />
        <StatePill s="cancelled" />
      </span>
    </div>
    <Ul>
      <Li>
        A run is created <C>pending</C> with one pending task run per task, becomes <C>running</C> when the orchestrator picks it up, and finishes{" "}
        <C>completed</C> when every task succeeds.
      </Li>
      <Li>
        A task that exhausts its retries is <C>failed</C>; the run is then <C>failed</C> with the error <C>task `id` failed: …</C>. Tasks in the same layer finish, and tasks never reached are marked <C>cancelled</C>.
      </Li>
      <Li>
        Cancelling a run marks it <C>cancelled</C> immediately, kills in-flight workers, and marks every non-terminal task <C>cancelled</C>. Cancelling a terminal run is a <C>409</C>.
      </Li>
    </Ul>

    <H2 id="triggers">Triggers</H2>
    <P>A run records what started it in its <C>trigger</C> field:</P>
    <Table
      head={["Trigger", "When", "Run params"]}
      rows={[
        [<C key="m">manual</C>, <><C>POST /api/workflows/{"{id}"}/trigger</C> — from curl, the console, or either SDK.</>, "Workflow params merged with the request's params."],
        [<C key="s">schedule</C>, <><C>triggers.every_secs</C> elapsed. The scheduler ticks every 2 s and waits one full interval after start-up before the first firing.</>, "Workflow params."],
        [<C key="i">ingest:&lt;dataset&gt;</C>, <>A batch landed in the dataset named by <C>triggers.on_ingest</C>.</>, <><C>{`{dataset, records, bytes, path}`}</C> merged over workflow params.</>],
        [<C key="mcp">mcp</C>, <>The MCP <C>trigger_workflow</C> tool.</>, "Workflow params merged with the tool's params."],
      ]}
    />

    <H2 id="execution-model">Execution model</H2>
    <Code
      lang="plain"
      title="One run, start to finish"
      code={`trigger (manual | schedule | ingest:<dataset> | mcp)
   │
   ▼
launch_run: persist Run + TaskRuns (pending) ── broadcast run_updated
   │
   ▼
topo_layers(DAG) — Kahn's algorithm (validated at create/update)
   │
   ├─ layer 0: [extract]              all tasks in a layer run concurrently,
   ├─ layer 1: [double, sum]          bounded by max_parallel_tasks
   └─ layer 2: [load]
        │  per task, up to retries + 1 attempts:
        ▼
   executor.execute(runtime, code, params, inputs)
        │  1. write job file to a scratch dir
        │  2. check out a warm worker (or spawn / sandbox one)
        │  3. send {"entry", "params", "inputs"} on stdin
        │  4. stream {"type":"log"} lines → broadcast + TaskRun.logs
        │  5. final {"type":"result"|"error"}; timeout ⇒ kill
        ▼
   result → inputs[task_id] for every dependent task`}
    />
    <P>
      Heavy data stays out of the control plane: ingestion streams to disk and an ingest-triggered run receives a <em>path</em> plus counters, not the payload. Task results flow as JSON and should be summaries or references. From inside any handler the <C>loom</C> bindings (<C>import loom</C> in Python, the <C>loom</C> global in JS/TS) query, ingest, and invoke against the platform.
    </P>

    <H3 id="runtimes">Runtimes</H3>
    <Table
      head={["Runtime", "Handler", "Notes"]}
      rows={[
        [<span key="p" className="runtime-badge python">py</span>, <C key="c">def handler(params, inputs):</C>, "Python 3.10+. print() lines stream as logs. Import inside the module; nothing is pre-installed beyond the standard library."],
        [<span key="t" className="runtime-badge typescript">ts</span>, <C key="c">export function handler(params, inputs)</C>, "Node 22+ with built-in type stripping (--experimental-strip-types). console.* lines stream as logs. Handlers may be async."],
        [<span key="j" className="runtime-badge javascript">js</span>, <C key="c">export function handler(params, inputs)</C>, "Plain ES modules on Node 20+. Shares one worker pool with TypeScript."],
      ]}
    />

    <Callout kind="warn" title="No authentication by default">
      Unless the server is started with <C>LOOM_PASSWORD</C>, Loom has no authentication: anyone who can reach the port can run code. The password is one shared credential for a trusted, single-tenant service — there are no users or roles. See <DocLink to="/docs/security">Security</DocLink> before exposing it.
    </Callout>

    <H2 id="pages">All pages</H2>
    <div className="doc-cards">
      {DOC_PAGES.filter((p) => p.slug !== "overview").map((p) => (
        <Link key={p.slug} to={`/docs/${p.slug}`} className="doc-card">
          <span className="t">{p.title}</span>
          <span className="d">{p.summary}</span>
        </Link>
      ))}
    </div>
  </>
);
