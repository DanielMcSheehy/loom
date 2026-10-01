# @loom/sdk (TypeScript)

TypeScript/JavaScript bindings for [Loom](../../README.md). Zero runtime
dependencies — built on `fetch` (Node 20+, Bun, Deno, browsers).

```bash
cd sdks/typescript && npm install && npm run build
```

## Define and deploy a flow

```ts
import { LoomClient, flow, task } from "@loom/sdk";

const extract = task("extract", async (params) => ({
  values: Array.from({ length: params.n as number }, (_, i) => i),
}));

const total = task(
  "total",
  async (_params, inputs) =>
    (inputs.extract as { values: number[] }).values.reduce((a, b) => a + b, 0),
  { dependsOn: [extract], retries: 2 },
);

const client = new LoomClient("http://localhost:7420");
const wf = await client.deploy(flow("sum-pipeline", [extract, total], { params: { n: 100 } }));
const run = await client.trigger(wf.id, { wait: true });
console.log(run.state); // "completed"
```

Handlers are serialized with `Function.prototype.toString()` and executed in
an isolated worker on the server, so they must be self-contained (no captured
variables). Typed handlers are safe: the whitespace gaps Node 22+ leaves
behind when it strips type annotations are collapsed before deploy, so the
stored source stays readable. To ship a task in another runtime, pass raw
source instead:

```ts
const crunch = task("crunch", {
  runtime: "python",
  code: "def handler(params, inputs):\n    return sum(inputs['extract']['values'])\n",
});
```

## Authentication

A server started with `LOOM_PASSWORD` rejects requests without the password
(HTTP 401, `LoomError.status === 401`). Pass it as `token` — it is sent as
`Authorization: Bearer <token>` on every request, event streams included —
or set `LOOM_API_TOKEN`, which the client reads by default wherever
`process.env` exists:

```ts
const client = new LoomClient("https://loom.example.com", { token: "the-server-password" });

// or: LOOM_API_TOKEN=the-server-password node app.js
const client = new LoomClient("https://loom.example.com");
```

A server without `LOOM_PASSWORD` has no authentication; no token is needed.
Don't ship the token in browser bundles — it is the server's only credential.

## Stream a run live

```ts
const run = await client.trigger(wf.id);
for await (const event of client.streamRun(run.id)) {
  if (event.type === "log") console.log(event.line);
}
```

Stop a run that is still pending/running: `await client.cancelRun(run.id)`
(resolves with the cancelled run; rejects with a 409 `LoomError` if it already finished).

## Serverless functions & ingestion

```ts
await client.createFunction({
  name: "hello",
  code: 'export const handler = (params) => `hi ${params.name}`;',
});
const { result } = await client.invoke("hello", { name: "loom" });

await client.ingest("sensor-readings", [{ sensor: "a", v: 1 }, { sensor: "b", v: 2 }]);
const profile = await client.describeDataset("sensor-readings", { sample: 5 }); // columns + row sample
console.log(profile.columns); // [{ name: "v", dtype: "integer", min: 1, max: 2, mean: 1.5, ... }, ...]
await client.deleteDataset("sensor-readings"); // file + registry row
```
