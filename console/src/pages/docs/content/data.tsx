import { C, Callout, Code, DocLink, Examples, H2, H3, Li, P, Table, Ul } from "../primitives";

export default (
  <>
    <H2 id="model">Datasets</H2>
    <P>
      A dataset is an append-only NDJSON file — one JSON object per line — stored at <C>LOOM_DATA_DIR/datasets/&lt;name&gt;.ndjson</C>, plus a registry row with record and byte counters. Datasets are created implicitly by the first ingest; there is no create route. Every dataset is immediately a SQL table (see <DocLink to="/docs/sql">SQL</DocLink>).
    </P>
    <Table
      head={["Field", "Meaning"]}
      rows={[
        [<C key="n">name</C>, <>Must match <C>[a-zA-Z0-9_-]{"{1,64}"}</C>. Dashes are fine; SQL also exposes an underscore alias.</>],
        [<C key="r">records</C>, "Total lines ingested so far (cumulative across batches)."],
        [<C key="b">bytes</C>, "Total bytes appended."],
        [<C key="c">created_at / updated_at</C>, "First and latest ingest."],
      ]}
    />

    <H2 id="ingest">Streaming ingestion</H2>
    <P>
      <C>POST /api/ingest/{"{dataset}"}</C> reads the request body as a byte stream and appends each chunk to the file as it arrives; gigabyte payloads never sit in memory. Records are counted by newline, and a last line without a trailing newline is counted and terminated so the next batch starts clean. Lines are not parsed on write — malformed JSON only surfaces when the dataset is queried or profiled.
    </P>
    <Examples
      examples={{
        curl: `# inline
printf '{"sensor":"a","value":10}\\n{"sensor":"b","value":5}\\n' \\
  | curl -X POST localhost:7420/api/ingest/readings -H 'content-type: application/x-ndjson' --data-binary @-

# a file of any size, streamed
curl -X POST localhost:7420/api/ingest/readings -H 'content-type: application/x-ndjson' --data-binary @events.ndjson

# → {"dataset": {"name": "readings", "records": 2, "bytes": 51, …},
#    "ingested": {"records": 2, "bytes": 51}, "triggered_runs": []}`,
        python: `# any iterable of JSON-serialisable records; generators are fine
res = client.ingest("readings", ({"sensor": f"s{i % 4}", "value": i * 0.5} for i in range(100_000)))
print(res["ingested"], res["triggered_runs"])`,
        typescript: `const res = await client.ingest("readings", [
  { sensor: "a", value: 10 },
  { sensor: "b", value: 5 },
]);`,
      }}
    />
    <Ul>
      <Li>
        The response carries the updated dataset record, the batch's own counts, and <C>triggered_runs</C>: ids of every workflow run started because its <C>triggers.on_ingest</C> named this dataset.
      </Li>
      <Li>
        An <C>ingested</C> event <C>{`{dataset, records, bytes}`}</C> is broadcast on <C>/api/events</C>.
      </Li>
      <Li>
        Inside tasks, <C>loom.ingest(dataset, records)</C> streams records the same way — the usual pattern is to aggregate in SQL and ingest the small result into a second dataset.
      </Li>
    </Ul>

    <H3 id="naming">Naming rules</H3>
    <P>
      Dataset, function, and connector names all share one rule: 1–64 ASCII letters, digits, underscores, or dashes. Anything else is rejected with <C>400 {`{"error": "dataset name must match [a-zA-Z0-9_-]{1,64}"}`}</C>. Names are case-sensitive.
    </P>

    <H2 id="profile">Column profiles</H2>
    <P>
      <C>GET /api/datasets/{"{name}"}?sample=N</C> scans the file with Polars (schema inferred from the first 1,000 lines) and returns per-column statistics plus the first <C>N</C> rows (default 20, clamped to 1–200). The console's Data page shows this as the dataset's schema card; the notebook cell picker uses it for templates.
    </P>
    <Code
      lang="json"
      code={`{
  "name": "readings", "records": 100000, "bytes": 3400000, "created_at": "…", "updated_at": "…",
  "columns": [
    { "name": "sensor", "dtype": "string", "null_count": 0, "min": "s0", "max": "s3", "mean": null,    "distinct": 4 },
    { "name": "value",  "dtype": "float",  "null_count": 0, "min": 0.0,  "max": 49999.5, "mean": 24999.75, "distinct": 100000 }
  ],
  "sample": [ { "sensor": "s0", "value": 0.0 }, { "sensor": "s1", "value": 0.5 } ],
  "sample_size": 2
}`}
    />
    <Table
      head={["Column field", "Values"]}
      rows={[
        [<C key="d">dtype</C>, <><C>integer</C>, <C>float</C>, <C>string</C>, <C>boolean</C>, <C>datetime</C>, <C>list</C>, <C>struct</C>, <C>null</C>, or <C>other</C>.</>],
        [<C key="n">null_count</C>, "Missing values in the column."],
        [<C key="m">min / max</C>, <>Numbers for numeric columns, strings for string/datetime columns, booleans for boolean columns; <C>null</C> for list/struct/other.</>],
        [<C key="a">mean</C>, <>Numeric columns only, otherwise <C>null</C>.</>],
        [<C key="s">distinct</C>, <>Exact distinct count (a null counts as a value); <C>null</C> for list/struct/other.</>],
      ]}
    />
    <Examples
      examples={{
        curl: `curl 'localhost:7420/api/datasets/readings?sample=5'`,
        python: `profile = client.describe_dataset("readings", sample=5)
for col in profile["columns"]:
    print(col["name"], col["dtype"], col["null_count"], col["min"], col["max"])`,
        typescript: `const profile = await client.describeDataset("readings", { sample: 5 });
for (const col of profile.columns) console.log(col.name, col.dtype, col.distinct);`,
      }}
    />

    <H2 id="manage">List and delete</H2>
    <Examples
      examples={{
        curl: `curl localhost:7420/api/datasets
curl -X DELETE localhost:7420/api/datasets/readings     # removes the file and the registry row (204)`,
        python: `client.list_datasets()
client.delete_dataset("readings")`,
        typescript: `await client.listDatasets();
await client.deleteDataset("readings");`,
      }}
    />

    <Callout kind="warn" title="Schema drift">
      A dataset's schema is whatever Polars infers from the first 1,000 lines. If later batches add columns or change a column's type, queries and profiles may fail or coerce values. Keep a dataset's record shape stable, or start a new dataset.
    </Callout>
  </>
);
