import { C, Callout, Code, DocLink, Examples, Fields, H2, H3, Li, P, Ul } from "../primitives";

export default (
  <>
    <H2 id="what">What a function is</H2>
    <P>
      A function is a named <C>handler(params, inputs)</C> you invoke over HTTP instead of scheduling in a DAG. It runs on the same executor and worker pool as workflow tasks, gets the same <C>loom</C> platform bindings, and is stored with an invocation counter. <C>inputs</C> is always <C>null</C> for a function; everything arrives through <C>params</C>.
    </P>
    <Fields
      rows={[
        { name: "name", type: "string", desc: "Must match [a-zA-Z0-9_-]{1,64}. Deploying again with the same name replaces the code and keeps the id and invocation count." },
        { name: "description", type: "string | null", note: "null", desc: "Shown in the console." },
        { name: "runtime", type: '"python" | "typescript" | "javascript"', desc: "Worker runtime." },
        { name: "code", type: "string", desc: "Module source." },
        { name: "timeout_secs", type: "integer", note: "300", desc: "Per invocation." },
      ]}
    />

    <H2 id="deploy">Deploy</H2>
    <Examples
      examples={{
        curl: `curl -X POST localhost:7420/api/functions -H 'content-type: application/json' -d '{
  "name": "hello",
  "runtime": "python",
  "description": "Greets by name",
  "code": "def handler(params, inputs):\\n    print(\\"greeting\\", params[\\"name\\"])\\n    return f\\"hi {params[\\"name\\"]}\\"\\n"
}'
# 201 {"id": "…", "spec": {…}, "invocations": 0, …}`,
        python: `client.create_function(
    "hello",
    "def handler(params, inputs):\\n    return f\\"hi {params['name']}\\"\\n",
    runtime="python",            # default
    description="Greets by name",
    timeout_secs=30,
)`,
        typescript: `await client.createFunction({
  name: "hello",
  runtime: "javascript",          // default for the TS SDK
  code: 'export const handler = (params) => \`hi \${params.name}\`;',
  description: "Greets by name",
  timeoutSecs: 30,
});`,
      }}
    />

    <H2 id="invoke">Invoke</H2>
    <P>
      <C>POST /api/functions/{"{name}"}/invoke</C> runs the handler and returns when it finishes. The HTTP status is <C>200</C> whether or not the handler succeeded — check <C>ok</C>. Only an unknown name is a <C>404</C>. Every invocation increments the counter and emits a <C>function_invoked</C> event with <C>ok</C> and <C>duration_ms</C>.
    </P>
    <Examples
      examples={{
        curl: `curl -X POST localhost:7420/api/functions/hello/invoke \\
  -H 'content-type: application/json' -d '{"params": {"name": "loom"}}'
# {"ok": true, "result": "hi loom", "logs": ["greeting loom"], "duration_ms": 1}

curl -X POST localhost:7420/api/functions/hello/invoke -d '{}' -H 'content-type: application/json'
# {"ok": false, "error": "workload failed: KeyError: 'name'", "duration_ms": 1}`,
        python: `res = client.invoke("hello", {"name": "loom"})
if res["ok"]:
    print(res["result"], res["logs"], res["duration_ms"])
else:
    print("failed:", res["error"])`,
        typescript: `const res = await client.invoke("hello", { name: "loom" });
if (res.ok) console.log(res.result, res.logs, res.duration_ms);
else console.error(res.error);`,
      }}
    />

    <H3 id="stream">Streamed invocation</H3>
    <P>
      <C>POST /api/functions/{"{name}"}/invoke/stream</C> responds with SSE: a named <C>log</C> event per printed line while the handler runs, then exactly one <C>result</C> or <C>error</C> event. Useful for long-running handlers whose progress you want to show.
    </P>
    <Code
      lang="bash"
      code={`curl -N -X POST localhost:7420/api/functions/hello/invoke/stream \\
  -H 'content-type: application/json' -d '{"params": {"name": "loom"}}'
# event: log
# data: greeting loom
#
# event: result
# data: {"result":"hi loom","duration_ms":2}`}
    />
    <P>Neither SDK wraps the streaming route; use <C>fetch</C> / <C>EventSource</C> or <C>urllib</C> directly.</P>

    <H3 id="from-tasks">Calling functions from tasks</H3>
    <P>Inside any task, function, or notebook cell, <C>loom.invoke(name, params)</C> performs the same POST and returns the response object.</P>
    <Examples
      examples={{
        python: `import loom

def handler(params, inputs):
    res = loom.invoke("hello", {"name": params.get("who", "world")})
    return res["result"]`,
        typescript: `export async function handler(params: any) {
  const res = await loom.invoke("hello", { name: params.who ?? "world" });
  return res.result;
}`,
      }}
    />

    <H2 id="manage">List, inspect, delete</H2>
    <Ul>
      <Li>
        <C>GET /api/functions</C> — every function with its spec and <C>invocations</C>.
      </Li>
      <Li>
        <C>GET /api/functions/{"{name}"}</C> — one function.
      </Li>
      <Li>
        <C>DELETE /api/functions/{"{name}"}</C> — remove it (<C>204</C>).
      </Li>
    </Ul>
    <Callout kind="note" title="Functions vs. /api/execute">
      <C>POST /api/execute</C> runs ad-hoc code with both <C>params</C> and <C>inputs</C> and does not persist anything or emit an event; functions are the deployed, named, counted form. Details in the <DocLink to="/docs/api#query">API reference</DocLink>.
    </Callout>
  </>
);
