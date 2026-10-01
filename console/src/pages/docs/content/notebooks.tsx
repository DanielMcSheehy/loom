import { C, Callout, Code, DocLink, Examples, Fields, H2, H3, Kbd, Li, P, Table, Ul } from "../primitives";

export default (
  <>
    <H2 id="model">Executable documents</H2>
    <P>
      A notebook is an ordered list of cells — <strong>markdown</strong>, <strong>code</strong> (Python, TypeScript, or JavaScript), and <strong>SQL</strong> — that run against the live platform. The server stores the cell array opaquely (<C>/api/notebooks</C>); the console owns the schema and executes cells through <C>POST /api/execute</C> (code) and <C>POST /api/query</C> (SQL). Outputs, chart specs, and view state are saved with the document, so a notebook reopens exactly as you left it.
    </P>
    <Fields
      rows={[
        { name: "id", type: "string", desc: "Client-generated cell id." },
        { name: "kind", type: '"markdown" | "code" | "sql"', desc: "Cell type." },
        { name: "name", type: "string", note: "unset", desc: "Optional. A named cell's output is available to cells below as inputs[name]." },
        { name: "runtime", type: '"python" | "typescript" | "javascript"', note: "python", desc: "Code cells only." },
        { name: "connector", type: "string", note: "unset", desc: "SQL cells only: run on a registered connector instead of the embedded engine." },
        { name: "code", type: "string", desc: "Markdown source, handler module, or SQL text." },
        { name: "output", type: "CellOutput | null", desc: "Last result: ok, result or rows, logs, error/trace, elapsed_ms, ran_at, fingerprint, truncated, row_count." },
        { name: "chart", type: "ChartSpec | null", desc: "Saved chart configuration for tabular output." },
        { name: "view", type: '"table" | "chart" | "json"', desc: "Which output tab is shown." },
        { name: "collapsed", type: "boolean", desc: "Editor hidden, output shown (an unpinned cell)." },
      ]}
    />

    <H2 id="chaining">How cells chain: prev and inputs[name]</H2>
    <P>
      When a code cell runs, the console collects the outputs of the successfully-run non-markdown cells above it and sends them as the handler's second argument. A SQL cell contributes its <C>rows</C>; a code cell contributes its <C>result</C>.
    </P>
    <Ul>
      <Li>
        <C>inputs.prev</C> (<C>inputs["prev"]</C> in Python) is the output of the nearest cell above that has one.
      </Li>
      <Li>
        Every named cell above adds <C>inputs[name]</C>; if two cells share a name the lower one wins.
      </Li>
      <Li>
        <C>params</C> is whatever the notebook passes — currently an empty object — so notebook handlers read from <C>inputs</C>.
      </Li>
    </Ul>
    <Code
      lang="sql"
      title={'Cell 1 · SQL · named "by_sensor"'}
      code={`SELECT sensor, AVG(value) AS avg_value, COUNT(*) AS n
FROM readings GROUP BY sensor ORDER BY sensor`}
    />
    <Examples
      title="Cell 2 · code"
      examples={{
        python: `def handler(params, inputs):
    rows = inputs["by_sensor"]          # or inputs["prev"]: the SQL cell is the nearest output above
    busiest = max(rows, key=lambda r: r["n"])
    print("busiest sensor:", busiest["sensor"])
    return {"busiest": busiest, "sensors": len(rows)}`,
        typescript: `export function handler(params: Record<string, unknown>, inputs: { by_sensor: { sensor: string; n: number }[] }) {
  const rows = inputs.by_sensor;
  const busiest = rows.reduce((a, b) => (b.n > a.n ? b : a));
  console.log("busiest sensor:", busiest.sensor);
  return { busiest, sensors: rows.length };
}`,
      }}
    />
    <P>
      Under the hood this is one <C>POST /api/execute</C> call with <C>{`{"runtime", "code", "params": {}, "inputs": {"by_sensor": [...], "prev": [...]}}`}</C>; the response's <C>result</C> and <C>logs</C> become the cell's output.
    </P>

    <H3 id="reactive">Reactive mode and stale cells</H3>
    <P>
      The editor parses each code cell for <C>inputs["name"]</C>, <C>inputs.get("name")</C>, <C>inputs.name</C>, and <C>inputs.prev</C> references to build a dependency graph (shown as the cell's "reads from" chips). With <strong>Reactive</strong> switched on (the default), running a cell enqueues every cell that transitively reads from it; cells run one at a time in document order through a queue. Each output stores a fingerprint of the code and inputs it was produced from, so a cell whose code or inputs changed since it last ran is flagged <em>stale</em>; <strong>Run all</strong> runs stale cells and cells without output.
    </P>

    <H2 id="sql-cells">SQL cells</H2>
    <P>
      A SQL cell runs its text through <C>/api/query</C> (5,000-row cap in the notebook) on the embedded engine, or on a connector chosen in the cell's header. Its rows feed <C>prev</C> / <C>inputs[name]</C> and open in the data grid or chart builder. See <DocLink to="/docs/sql">SQL & connectors</DocLink> for table naming.
    </P>

    <H2 id="charts">Charts</H2>
    <P>
      Any tabular output — SQL rows, or a code cell returning an array of objects — gets a <strong>Table</strong>, <strong>Chart</strong>, and <strong>JSON</strong> tab. The chart builder edits a <C>ChartSpec</C> saved on the cell:
    </P>
    <Table
      head={["Field", "Values"]}
      rows={[
        [<C key="m">mark</C>, <><C>bar</C>, <C>hbar</C>, <C>line</C>, <C>area</C>, <C>scatter</C>, <C>pie</C>, <C>histogram</C>, <C>radar</C></>],
        [<C key="x">x / y</C>, "The x column and one or more y columns."],
        [<C key="c">color</C>, "Column to split series by (the categorical palette, up to eight series, the rest folded into Other)."],
        [<C key="a">agg</C>, <><C>none</C>, <C>sum</C>, <C>avg</C>, <C>count</C>, <C>min</C>, <C>max</C>, <C>median</C> — applied per x bucket.</>],
        [<C key="o">stack / normalize / sort / limit / logY / bins / labels / title</C>, "Stacking and 100% stacking, x/y sorting, top-N limit, log y axis, histogram bin count, value labels, chart title."],
        [<C key="s">stats</C>, <>Line/area only: draw <C>avg</C>/<C>min</C>/<C>max</C>/<C>median</C> lines per x bucket instead of one aggregated line.</>],
      ]}
    />
    <P>Charts are rendered as SVG in both themes with hover tooltips and legends; run-state colours and the series palette come from the console's design tokens.</P>

    <H2 id="editor">Editor: autocomplete, hover types, Insert types</H2>
    <P>
      Code cells (and workflow task editors) know what <C>params</C> and <C>inputs</C> will contain, inferred from the actual values of the cells above (or upstream tasks' last results). The editor uses that context in three ways:
    </P>
    <Ul>
      <Li>
        <strong>Completion</strong> — typing <C>inputs.</C>, <C>inputs["</C>, or a path into a value (<C>inputs.by_sensor[0].</C>) offers the known keys, including through local aliases such as <C>rows = inputs["by_sensor"]</C> or <C>for r in rows</C>.
      </Li>
      <Li>
        <strong>Hover</strong> — hovering a <C>params</C>/<C>inputs</C> expression shows its inferred type and a sample value.
      </Li>
      <Li>
        <strong>Insert types</strong> — the <C>{"{ }"} types</C> button in the editor's corner writes an <C>Inputs</C> / <C>Params</C> type stub from the inferred shapes and annotates the handler signature (TypeScript types, JSDoc typedefs for JavaScript, a typed signature for Python). The stub sits between <C>loom:types</C> marker comments, so pressing it again replaces the block instead of stacking copies.
      </Li>
    </Ul>
    <Code
      lang="typescript"
      title="After “Insert types” on the cell above"
      code={`// loom:types — inferred from the current inputs/params; use “Insert types” again to refresh.
type Inputs = {
  by_sensor: { sensor: string; avg_value: number; n: number }[];
  prev: { sensor: string; avg_value: number; n: number }[];
};
type Params = {};
// loom:types end
export function handler(params: Params, inputs: Inputs) {
  …
}`}
    />

    <H2 id="shortcuts">Working in the console</H2>
    <Table
      head={["Action", "How"]}
      rows={[
        ["Run a cell", <><Kbd>⌘⏎</Kbd> / <Kbd>Ctrl⏎</Kbd>, or the run button. <Kbd>Shift⏎</Kbd> runs and moves to the next cell.</>],
        ["Insert a cell", "The + between cells: pick markdown / code / SQL, or a template built from your datasets."],
        ["Name a cell", "The name field in the cell header (exposes inputs[name])."],
        ["Reorder / duplicate / delete", "Cell toolbar buttons, or drag the handle."],
        ["Collapse the editor", "Hide the code and keep the output (an unpinned cell)."],
        ["Run all", "Runs stale cells and cells with no output, in order."],
        ["Export", "Download the document as JSON, or as Markdown with code blocks and result tables."],
      ]}
    />

    <H2 id="publishing">Publishing a notebook</H2>
    <P>
      <strong>Publish</strong> in the notebook header makes the notebook readable by anyone with its link, without logging in — useful for sharing a report from a server protected by <C>LOOM_PASSWORD</C>. The link is the notebook's normal address (<C>/notebooks/{"{id}"}</C>; <strong>Copy public link</strong> puts it on the clipboard). Published notebooks carry a <strong>Public</strong> badge in the header and in the notebook list.
    </P>
    <Ul>
      <Li>
        Visitors get a read-only page: rendered markdown, highlighted code, and each cell's <em>stored</em> output and chart, with the outline alongside. They can switch between Table, Chart, and JSON and sort or filter a result grid, but there is nothing to run, edit, or save.
      </Li>
      <Li>
        Publishing never grants execution. Cells are not re-run for visitors; <C>/api/execute</C>, <C>/api/query</C>, and every write stay behind the password.
      </Li>
      <Li>
        What visitors see is what was last saved, including outputs — check that no cell output shows data you would not share. Later edits and re-runs show up for visitors once saved. <strong>Unpublish</strong> closes the link immediately.
      </Li>
    </Ul>
    <P>
      Over the API: <DocLink to="/docs/api#post-api-notebooks-id-publish">POST /api/notebooks/{"{id}"}/publish</DocLink> and <C>/unpublish</C>. See <DocLink to="/docs/security#published">Security</DocLink> for exactly what is and is not exposed.
    </P>

    <H2 id="api">Notebooks over the API</H2>
    <P>
      The routes are plain CRUD: <C>GET/POST /api/notebooks</C>, <C>GET/PUT/DELETE /api/notebooks/{"{id}"}</C>, plus <C>POST …/publish</C> and <C>…/unpublish</C>. Cells are any JSON, but only the schema above renders in the console. The MCP <C>create_notebook</C> tool creates a document the same way.
    </P>
    <Examples
      examples={{
        curl: `curl -X POST localhost:7420/api/notebooks -H 'content-type: application/json' -d '{
  "name": "Sensor analysis",
  "cells": [
    {"id": "c1", "kind": "markdown", "code": "## Readings by sensor"},
    {"id": "c2", "kind": "sql", "name": "by_sensor",
     "code": "SELECT sensor, AVG(value) AS avg_value, COUNT(*) AS n FROM readings GROUP BY sensor"},
    {"id": "c3", "kind": "code", "runtime": "python",
     "code": "def handler(params, inputs):\\n    return max(inputs[\\"by_sensor\\"], key=lambda r: r[\\"n\\"])\\n"}
  ]
}'`,
      }}
    />
    <Callout kind="note" title="Outputs are not computed server-side">
      Creating a notebook stores the cells only; open it in the console and run them (or run the cells' code yourself through <DocLink to="/docs/api#post-api-execute">POST /api/execute</DocLink>) to produce outputs.
    </Callout>
  </>
);
