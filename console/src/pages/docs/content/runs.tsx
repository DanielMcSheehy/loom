import { C, Callout, Code, DocLink, Examples, Fields, H2, H3, Li, P, Table, Ul } from "../primitives";

export default (
  <>
    <H2 id="run-object">The Run object</H2>
    <P>
      <C>POST /api/workflows/{"{id}"}/trigger</C> returns a run immediately (<C>202</C>); execution continues in the background. <C>GET /api/runs/{"{id}"}</C> returns <C>{`{"run", "tasks"}`}</C> with one <C>TaskRun</C> per task, ordered by start time.
    </P>
    <Fields
      rows={[
        { name: "id", type: "uuid", desc: "Run id." },
        { name: "workflow_id / workflow_name", type: "uuid / string", desc: "The workflow at launch time (the name is a snapshot)." },
        { name: "state", type: "RunState", desc: "pending → running → completed | failed | cancelled." },
        { name: "params", type: "json", desc: "Effective run params: workflow params merged with the trigger's params." },
        { name: "trigger", type: "string", desc: '"manual", "schedule", "ingest:<dataset>", or "mcp".' },
        { name: "error", type: "string | null", note: "null", desc: 'For failed runs: "task `id` failed: …"; for cancelled runs: "cancelled by user".' },
        { name: "created_at / started_at / finished_at", type: "timestamp | null", desc: "started_at is set on pending → running; finished_at on any terminal transition." },
      ]}
    />

    <H3 id="task-run">TaskRun</H3>
    <Fields
      rows={[
        { name: "id / run_id / task_id", type: "uuid / uuid / string", desc: "task_id is the TaskSpec id; name is the display name." },
        { name: "state", type: "RunState", desc: "Same states as the run." },
        { name: "attempts", type: "integer", desc: "Attempts started so far (0 until the task first runs; at most retries + 1)." },
        { name: "result", type: "json | null", desc: "The handler's return value once completed." },
        { name: "error", type: "string | null", desc: "Last attempt's error message." },
        { name: "logs", type: "string[]", desc: "Every log line across all attempts, plus [trace] lines from a failed attempt's traceback." },
        { name: "started_at / finished_at", type: "timestamp | null", desc: "Per task." },
      ]}
    />

    <H2 id="lifecycle">Lifecycle</H2>
    <Ul>
      <Li>
        <strong>pending</strong> — the run and its task runs are persisted and a <C>run_updated</C> event is broadcast before the background orchestrator starts.
      </Li>
      <Li>
        <strong>running</strong> — set when the orchestrator picks the run up (<C>started_at</C>). Each task becomes <C>running</C> when its first attempt starts.
      </Li>
      <Li>
        <strong>completed</strong> — every task completed. <strong>failed</strong> — a task exhausted its retries; unreached tasks are <C>cancelled</C>. <strong>cancelled</strong> — stopped by <C>POST /api/runs/{"{id}"}/cancel</C>.
      </Li>
      <Li>Terminal states are written exactly once and never overwritten, even when a cancel races the run's own completion.</Li>
    </Ul>

    <H2 id="cancel">Cancelling a run</H2>
    <P>
      Cancellation is synchronous from the caller's point of view: the response already shows <C>state: "cancelled"</C>. The orchestrator notices the cancellation before each layer and while awaiting each task, kills in-flight workers, skips remaining retries, and marks every non-terminal task <C>cancelled</C>. A run that has no live orchestrator (for example after a server restart mid-run) is cleaned up by the cancel call itself.
    </P>
    <Examples
      examples={{
        curl: `curl -X POST localhost:7420/api/runs/$RUN/cancel
# 202 {"id": "…", "state": "cancelled", "error": "cancelled by user", …}
# 409 {"error": "run is already completed"}   when it had already finished`,
        python: `from loom_sdk import LoomClient
client = LoomClient()
try:
    run = client.cancel_run(run_id)
except LoomError as e:          # e.status == 409 when already terminal
    print(e)`,
        typescript: `try {
  const run = await client.cancelRun(runId);
} catch (e) {
  if (e instanceof LoomError && e.status === 409) console.log("already finished");
}`,
      }}
    />

    <H2 id="events">The event stream</H2>
    <P>
      Every observable change is a <C>LoomEvent</C> on an in-process broadcast bus. Two SSE endpoints subscribe to it: <C>GET /api/events</C> (everything) and <C>GET /api/runs/{"{id}"}/events</C> (only events belonging to that run). Each SSE message's <C>data</C> is one JSON object tagged by <C>type</C>. Keep-alive comments are sent every 15 seconds. Slow consumers that fall behind the buffer skip the dropped events instead of losing the stream. Nothing is replayed: subscribe first, then fetch current state.
    </P>
    <Table
      head={["type", "Payload", "Emitted when"]}
      rows={[
        [<C key="t">run_updated</C>, <C key="p">{`{ ts, run: Run }`}</C>, "A run is created or changes state."],
        [<C key="t">task_updated</C>, <C key="p">{`{ ts, task: TaskRun }`}</C>, "A task run starts, finishes an attempt, completes, fails, or is cancelled. Carries the full task including result and logs."],
        [<C key="t">log</C>, <C key="p">{`{ ts, run_id, task_id, line }`}</C>, "A worker prints a line (streamed live), or the orchestrator notes a retry."],
        [<C key="t">ingested</C>, <C key="p">{`{ ts, dataset, records, bytes }`}</C>, "POST /api/ingest/{dataset} persisted a batch."],
        [<C key="t">function_invoked</C>, <C key="p">{`{ ts, name, ok, duration_ms }`}</C>, "A function finished via invoke or invoke/stream (not via /api/execute)."],
      ]}
    />
    <Code
      lang="json"
      title="Wire format"
      code={`{"type":"run_updated","ts":"2026-09-30T10:00:00.120Z","run":{"id":"9a2d…","state":"running",…}}
{"type":"task_updated","ts":"…","task":{"task_id":"extract","state":"running","attempts":1,"logs":[],…}}
{"type":"log","ts":"…","run_id":"9a2d…","task_id":"extract","line":"pulling 100 records"}
{"type":"task_updated","ts":"…","task":{"task_id":"extract","state":"completed","result":{…},…}}
{"type":"run_updated","ts":"…","run":{"id":"9a2d…","state":"completed","finished_at":"…",…}}`}
    />
    <P>The per-run stream only carries <C>run_updated</C>, <C>task_updated</C>, and <C>log</C>; <C>ingested</C> and <C>function_invoked</C> have no run and appear only on the global stream.</P>

    <H3 id="following-a-run">Following a run to completion</H3>
    <P>
      Both SDKs implement the safe pattern: open the run's stream, <em>then</em> check the current state (returning at once if it is already terminal), then yield events until a <C>run_updated</C> with a terminal state arrives.
    </P>
    <Examples
      examples={{
        curl: `# raw SSE
curl -N localhost:7420/api/runs/$RUN/events

# in a browser
const es = new EventSource("/api/runs/" + runId + "/events");
es.onmessage = (m) => console.log(JSON.parse(m.data));`,
        python: `for event in client.stream_run(run["id"]):
    if event["type"] == "log":
        print(f"[{event['task_id']}] {event['line']}")
    elif event["type"] == "task_updated":
        print(event["task"]["task_id"], event["task"]["state"])
    elif event["type"] == "run_updated":
        print("run:", event["run"]["state"])

# the whole platform, forever (blocks):
for event in client.events():
    ...`,
        typescript: `for await (const ev of client.streamRun(run.id)) {
  if (ev.type === "log") console.log(\`[\${ev.task_id}] \${ev.line}\`);
  if (ev.type === "run_updated") console.log("run:", (ev.run as { state: string }).state);
}

// every event, with cancellation:
const ac = new AbortController();
for await (const ev of client.events(undefined, ac.signal)) { /* … */ }`,
      }}
    />

    <H2 id="history">Run history</H2>
    <P>
      <C>GET /api/runs?workflow_id=&limit=</C> lists runs newest first (default 50, max 500). The console's Runs page merges live <C>run_updated</C> events into this list by id; the workflow detail page uses the same data for its duration trend.
    </P>
    <Callout kind="note" title="Polling vs. streaming">
      <C>trigger(..., wait=True)</C> in the Python SDK and <C>trigger(id, {`{ wait: true }`})</C> in TypeScript poll <C>GET /api/runs/{"{id}"}</C> every 500 ms; use the event stream when you need logs or intermediate task states. See <DocLink to="/docs/api#events">the API reference</DocLink> for the exact routes.
    </Callout>
  </>
);
