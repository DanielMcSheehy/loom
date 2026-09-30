import { C, Callout, Code, DocLink, Examples, H2, H3, Li, P, Table, Ul } from "../primitives";

export default (
  <>
    <H2 id="engine">The embedded engine</H2>
    <P>
      <C>POST /api/query</C> executes SQL in-process with <strong>Polars</strong>, a Rust dataframe engine. Every ingested dataset is registered as a lazily scanned table, so aggregations and joins across datasets run without loading whole files: Polars pushes projections and predicates down to the NDJSON scan and only materialises the columns and rows the query needs. Queries run on a blocking thread pool so the API stays responsive.
    </P>
    <Examples
      examples={{
        curl: `curl -X POST localhost:7420/api/query -H 'content-type: application/json' -d '{
  "sql": "SELECT sensor, AVG(value) AS avg_value, COUNT(*) AS n FROM readings GROUP BY sensor ORDER BY sensor",
  "limit": 1000
}'
# {"rows": [{"sensor": "s0", "avg_value": 24998.0, "n": 25000}, …], "row_count": 4, "truncated": false, "elapsed_ms": 18}`,
        python: `rows = client.query(
    "SELECT sensor, AVG(value) AS avg_value, COUNT(*) AS n FROM readings GROUP BY sensor ORDER BY sensor",
    limit=1000,
)
# rows == [{"sensor": "s0", "avg_value": 24998.0, "n": 25000}, …]`,
        typescript: `const rows = await client.query(
  "SELECT sensor, AVG(value) AS avg_value, COUNT(*) AS n FROM readings GROUP BY sensor ORDER BY sensor",
  { limit: 1000 },
);`,
      }}
    />
    <Table
      head={["Request field", "Default", "Notes"]}
      rows={[
        [<C key="s">sql</C>, "required", "One statement. Polars' SQL dialect: SELECT / WHERE / GROUP BY / ORDER BY / JOIN / LIMIT, common aggregates and functions."],
        [<C key="l">limit</C>, "10000", "Row cap, clamped to 1–200000. The engine fetches one extra row to set truncated."],
        [<C key="c">connector</C>, "none", "Route to a registered external engine instead (below)."],
      ]}
    />
    <P>
      The response is <C>{`{"rows", "row_count", "truncated", "elapsed_ms"}`}</C>; rows are JSON objects keyed by column. Bad SQL or an unknown table is a <C>400</C> with <C>{`{"error": "query failed: …"}`}</C>.
    </P>

    <H3 id="table-names">Table names</H3>
    <Ul>
      <Li>
        Each dataset is a table with exactly its name: <C>SELECT * FROM readings</C>.
      </Li>
      <Li>
        A dataset with dashes is also registered under an underscore alias, because dashes are awkward in SQL identifiers: <C>sensor-readings</C> is queryable as <C>sensor_readings</C>. The alias only maps <C>-</C> → <C>_</C>; nothing else is rewritten.
      </Li>
      <Li>Datasets whose file is missing from disk are skipped silently.</Li>
    </Ul>
    <Code
      lang="sql"
      code={`-- join two datasets; "sensor-meta" is reachable as sensor_meta
SELECT m.zone, AVG(r.value) AS avg_value
FROM readings r
JOIN sensor_meta m ON m.sensor = r.sensor
WHERE r.value > 10
GROUP BY m.zone
ORDER BY avg_value DESC
LIMIT 20`}
    />

    <H3 id="from-code">From tasks and notebooks</H3>
    <P>
      <C>loom.query(sql, limit=10000)</C> inside any task or function returns the rows array. Notebook SQL cells run the same route and hand their rows to the cells below as <C>inputs.prev</C> / <C>inputs[name]</C>. Because the engine runs in the server, workers need no pandas or numpy: aggregate millions of rows in Rust and pass the small result downstream.
    </P>
    <Examples
      examples={{
        python: `import loom

def handler(params, inputs):
    top = loom.query("""
        SELECT sensor, MAX(value) AS peak FROM readings
        GROUP BY sensor ORDER BY peak DESC LIMIT 5
    """)
    return {"top": top}`,
        typescript: `export async function handler() {
  const top = await loom.query("SELECT sensor, MAX(value) AS peak FROM readings GROUP BY sensor ORDER BY peak DESC LIMIT 5");
  return { top };
}`,
      }}
    />

    <H2 id="connectors">Connectors: external engines</H2>
    <P>
      Register a connector once, then pass <C>"connector": "name"</C> to <C>/api/query</C> (or <C>connector=</C> in the SDKs, or pick it in a notebook SQL cell / the Data page workbench) to run the statement there instead of on the embedded engine. The response gains a <C>connector</C> field; <C>limit</C> still caps the rows.
    </P>
    <Table
      head={["kind", "Transport", "url", "Notes"]}
      rows={[
        [<C key="k">postgres</C>, "Native protocol (tokio-postgres), no TLS", <C key="u">postgres://user:pw@host:5432/db</C>, "Read queries. Columns are converted per type: bool, int2/4/8, float4/8, json/jsonb, timestamp(tz), date, uuid; everything else as text."],
        [<C key="k">clickhouse</C>, "HTTP interface", <C key="u">http://host:8123</C>, "FORMAT JSONEachRow is appended unless the SQL already names a FORMAT."],
        [<C key="k">chdb</C>, "Embedded ClickHouse inside the Python worker", "(unused)", "Requires pip install chdb in the worker's Python environment; each query runs as a Python job with a 300 s timeout."],
      ]}
    />
    <Examples
      examples={{
        curl: `# register
curl -X POST localhost:7420/api/connectors -H 'content-type: application/json' \\
  -d '{"name": "warehouse", "kind": "postgres", "url": "postgres://app:secret@db.internal:5432/app"}'

# query through it
curl -X POST localhost:7420/api/query -H 'content-type: application/json' \\
  -d '{"sql": "SELECT count(*) AS n FROM orders", "connector": "warehouse"}'
# {"rows": [{"n": 1204}], "row_count": 1, "truncated": false, "connector": "warehouse", "elapsed_ms": 9}

# list / remove
curl localhost:7420/api/connectors
curl -X DELETE localhost:7420/api/connectors/warehouse`,
        python: `rows = client.query("SELECT count(*) AS n FROM orders", connector="warehouse")`,
        typescript: `const rows = await client.query("SELECT count(*) AS n FROM orders", { connector: "warehouse" });`,
      }}
    />
    <Ul>
      <Li>
        Names follow the shared rule <C>[a-zA-Z0-9_-]{"{1,64}"}</C>. <C>postgres</C> and <C>clickhouse</C> require a <C>url</C> (<C>400 this connector kind requires a url</C>); <C>chdb</C> ignores it. Registering an existing name replaces it.
      </Li>
      <Li>Connector errors (connection refused, bad SQL) come back as <C>400</C> with the engine's message; an unknown connector name is <C>404</C>.</Li>
      <Li>
        The in-task <C>loom.query()</C> binding always uses the embedded engine; call the HTTP route directly from a task if you need a connector.
      </Li>
    </Ul>
    <Callout kind="warn" title="Connector URLs are stored in plaintext">
      URLs, including passwords, are written as-is to the SQLite store and returned by <C>GET /api/connectors</C>. Treat the data directory as sensitive; see <DocLink to="/docs/security">Security</DocLink>.
    </Callout>

    <H2 id="console">The Data page</H2>
    <P>
      The console's Data page lists datasets with their profiles, manages connectors, and has a SQL workbench with schema hints and query history that calls this same route with a 5,000-row cap. Results open in the data grid with column summaries, sorting, filtering, and CSV/JSON export, or in the chart builder.
    </P>
  </>
);
