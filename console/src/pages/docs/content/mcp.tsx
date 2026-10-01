import { C, Callout, Code, DocLink, H2, H3, Li, P, Table, Ul } from "../primitives";

interface Tool {
  name: string;
  desc: string;
  args: Array<{ name: string; type: string; required?: boolean; desc: string }>;
  returns: string;
}

const TOOLS: Tool[] = [
  { name: "loom_stats", desc: "Platform counters: workflows, runs, functions, datasets, ingested volume.", args: [], returns: "The Stats object (same as GET /api/stats)." },
  {
    name: "execute_code",
    desc: "Run a code snippet on the warm worker pool and get its result + logs. The code must define handler(params, inputs) (Python) or export it (JS/TS).",
    args: [
      { name: "runtime", type: '"python" | "typescript" | "javascript"', required: true, desc: "Worker runtime." },
      { name: "code", type: "string", required: true, desc: "Module source." },
      { name: "params", type: "object", desc: "Handler's first argument (inputs is null). 120 s timeout." },
    ],
    returns: '{ "result", "logs" }. A failing handler is an isError result with the message.',
  },
  {
    name: "query",
    desc: "Run SQL. Default engine: embedded Polars over ingested datasets (dataset names are tables; dashes aliased to underscores; joins allowed). Pass connector to target a registered Postgres/ClickHouse/chDB source.",
    args: [
      { name: "sql", type: "string", required: true, desc: "The statement." },
      { name: "connector", type: "string", desc: "Registered connector name." },
      { name: "limit", type: "integer", desc: "Row cap; default 1000, clamped to 1..100000." },
    ],
    returns: '{ "rows", "truncated" }',
  },
  {
    name: "ingest",
    desc: "Append records to a named dataset (creates it on first ingest).",
    args: [
      { name: "dataset", type: "string", required: true, desc: "Dataset name." },
      { name: "records", type: "object[]", required: true, desc: "Records to append as NDJSON lines." },
    ],
    returns: "The updated Dataset record { name, records, bytes, created_at, updated_at }.",
  },
  { name: "list_datasets", desc: "List ingested datasets with record/byte counts.", args: [], returns: "Dataset[]" },
  {
    name: "describe_dataset",
    desc: "Profile a dataset: per-column dtype, null_count, min/max/mean, distinct count, plus the first rows as a sample.",
    args: [
      { name: "name", type: "string", required: true, desc: "Dataset name." },
      { name: "sample", type: "integer", desc: "Sample rows to return (default 20, max 200)." },
    ],
    returns: "The same object as GET /api/datasets/{name}.",
  },
  { name: "list_workflows", desc: "List workflows with their DAG specs.", args: [], returns: "Workflow[]" },
  {
    name: "create_workflow",
    desc: "Create or replace a workflow. Upserts by spec.name so an agent can iterate on a workflow; the DAG is validated.",
    args: [{ name: "spec", type: "WorkflowSpec", required: true, desc: "{ name, params?, tasks: [{ id, runtime, code, depends_on?, retries?, timeout_secs? }], triggers?: { every_secs?, on_ingest? } }" }],
    returns: "The stored Workflow { id, spec, created_at, updated_at }.",
  },
  {
    name: "trigger_workflow",
    desc: "Start a run of a workflow by id or name. Returns the run; poll get_run for completion. The run's trigger is recorded as \"mcp\".",
    args: [
      { name: "workflow", type: "string", required: true, desc: "Workflow UUID or exact name." },
      { name: "params", type: "object", desc: "Merged over the workflow's params." },
    ],
    returns: "The pending Run.",
  },
  { name: "get_run", desc: "Get a run's state plus every task's state, result, error, and logs.", args: [{ name: "run_id", type: "uuid", required: true, desc: "Run id." }], returns: '{ "run", "tasks" }' },
  { name: "cancel_run", desc: "Cancel a pending or running run. In-flight tasks are stopped and marked cancelled.", args: [{ name: "run_id", type: "uuid", required: true, desc: "Run id." }], returns: "The cancelled Run; an isError result \"run is already <state>\" if it had finished." },
  {
    name: "list_runs",
    desc: "Recent runs, optionally filtered by workflow id.",
    args: [
      { name: "workflow_id", type: "uuid", desc: "Filter." },
      { name: "limit", type: "integer", desc: "Default 20, clamped to 1..200." },
    ],
    returns: "Run[]",
  },
  {
    name: "invoke_function",
    desc: "Invoke a deployed serverless function with params.",
    args: [
      { name: "name", type: "string", required: true, desc: "Function name." },
      { name: "params", type: "object", desc: "Handler's first argument." },
    ],
    returns: '{ "result", "logs" }; the invocation counter is incremented.',
  },
  {
    name: "create_function",
    desc: "Deploy (or update) a serverless function. Upserts by name; timeout_secs is the FunctionSpec default (300).",
    args: [
      { name: "name", type: "string", required: true, desc: "Function name." },
      { name: "runtime", type: '"python" | "typescript" | "javascript"', required: true, desc: "Worker runtime." },
      { name: "code", type: "string", required: true, desc: "Module source." },
      { name: "description", type: "string", desc: "Free text." },
    ],
    returns: "The stored Function.",
  },
  {
    name: "create_notebook",
    desc: "Create a notebook document with cells (markdown/code/sql) shown in the console.",
    args: [
      { name: "name", type: "string", required: true, desc: "Display name." },
      { name: "cells", type: "array", desc: "NotebookCell objects; defaults to []." },
    ],
    returns: "The stored Notebook.",
  },
];

export default (
  <>
    <H2 id="transport">Endpoint and transport</H2>
    <P>
      <C>POST /mcp</C> implements the Model Context Protocol's streamable-HTTP transport as a stateless server: each request is one JSON-RPC 2.0 message and each response is plain JSON (no SSE upgrade). Protocol version <C>2025-06-18</C>. The endpoint is mounted at the root, not under <C>/api</C>.
    </P>
    <Table
      head={["Method", "Behaviour"]}
      rows={[
        [<C key="i">initialize</C>, <>Returns <C>protocolVersion</C>, <C>capabilities: {`{ tools: {} }`}</C>, <C>serverInfo: {`{ name: "loom", version }`}</C>, and an <C>instructions</C> string describing the platform.</>],
        [<C key="p">ping</C>, <>Returns <C>{`{}`}</C>.</>],
        [<C key="l">tools/list</C>, "Returns the 15 tool definitions below with their JSON input schemas."],
        [<C key="c">tools/call</C>, <>Runs a tool. Result: <C>{`{ content: [{ type: "text", text }], isError }`}</C> where <C>text</C> is the tool's JSON output (or the error message when <C>isError</C> is true).</>],
        ["notifications (no id)", <>Acknowledged with HTTP <C>202</C> and no body.</>],
        ["anything else", <>JSON-RPC error <C>{`{ code: -32601, message: "method not found: …" }`}</C>.</>],
      ]}
    />

    <H3 id="register">Register with a client</H3>
    <P>
      When the server has <C>LOOM_PASSWORD</C> set, <C>/mcp</C> requires <C>Authorization: Bearer &lt;password&gt;</C> like every REST route (otherwise <C>401</C>); add the header when registering. Without a password the endpoint is open — see <DocLink to="/docs/security">Security</DocLink>.
    </P>
    <Code
      lang="bash"
      code={`# Claude Code
claude mcp add --transport http loom http://localhost:7420/mcp
# …against a server with LOOM_PASSWORD
claude mcp add --transport http loom https://loom.example.com/mcp --header "Authorization: Bearer $LOOM_PASSWORD"

# by hand
curl -X POST localhost:7420/mcp -H 'content-type: application/json' \\
  -d '{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}'

curl -X POST localhost:7420/mcp -H 'content-type: application/json' \\
  -d '{"jsonrpc": "2.0", "id": 2, "method": "tools/call",
       "params": {"name": "query", "arguments": {"sql": "SELECT COUNT(*) AS n FROM readings"}}}'
# {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"rows\\":[{\\"n\\":100000}],\\"truncated\\":false}"}],"isError":false}}`}
    />

    <H2 id="tools">Tools</H2>
    <P>Every tool takes a JSON object of arguments. Required arguments are marked; the rest are optional.</P>
    {TOOLS.map((t) => (
      <section key={t.name} className="doc-endpoint">
        <H3 id={`tool-${t.name}`}>{t.name}</H3>
        <P>{t.desc}</P>
        {t.args.length > 0 ? (
          <Table
            head={["Argument", "Type", "Description"]}
            rows={t.args.map((a) => [
              <span key="n">
                <C>{a.name}</C>
                {a.required && <span className="doc-status" style={{ marginLeft: 6 }}>required</span>}
              </span>,
              <span key="t" className="doc-type">{a.type}</span>,
              a.desc,
            ])}
          />
        ) : (
          <P>
            <em>No arguments.</em>
          </P>
        )}
        <P>
          <strong>Returns</strong> {t.returns}
        </P>
      </section>
    ))}

    <H2 id="agent-loop">A typical agent session</H2>
    <Ul>
      <Li>
        <C>list_datasets</C> → <C>describe_dataset</C> to learn the schema, then <C>query</C> to explore.
      </Li>
      <Li>
        <C>execute_code</C> to prototype a handler against real data, then <C>create_workflow</C> with the tasks (upsert by name lets the agent iterate), <C>trigger_workflow</C>, and <C>get_run</C> until the state is terminal.
      </Li>
      <Li>
        <C>create_notebook</C> to leave a runnable write-up in the console.
      </Li>
    </Ul>
    <Callout kind="note" title="Differences from the REST routes">
      The MCP <C>ingest</C> tool appends the records and updates the counters but does not launch <C>on_ingest</C> workflows or emit an <C>ingested</C> event; use <DocLink to="/docs/api#post-api-ingest-dataset">POST /api/ingest</DocLink> when triggers must fire. <C>query</C> defaults to 1,000 rows (REST: 10,000) and omits <C>row_count</C>/<C>elapsed_ms</C>. <C>create_workflow</C> upserts by name, where the REST <C>POST</C> always creates.
    </Callout>
  </>
);
