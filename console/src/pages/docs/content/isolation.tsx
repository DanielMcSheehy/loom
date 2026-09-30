import { C, Callout, Code, DocLink, H2, H3, Li, P, Table, Ul } from "../primitives";

export default (
  <>
    <H2 id="how-workers-run">How a job runs</H2>
    <P>
      Every execution — a workflow task, a function invocation, an <C>/api/execute</C> call, a notebook cell — goes through the executor. It writes the code to a scratch file (<C>job.py</C>, <C>job.ts</C>, or <C>job.mjs</C>), hands it to a worker shim over stdin, and reads JSON-lines events back over stdout. The shims are embedded in the server binary and materialised to a temp dir at start-up, so the binary has no runtime file dependencies.
    </P>
    <Code
      lang="plain"
      title="Worker wire protocol"
      code={`→ stdin   {"entry": "/tmp/loom-job-x/job.py", "params": {...}, "inputs": {...}}
← stdout  {"type": "log",    "line": "..."}                     0..n, streamed live
← stdout  {"type": "result", "value": <json>}                   exactly one of
← stdout  {"type": "error",  "message": "...", "trace": "..."}    these ends the job`}
    />
    <Ul>
      <Li>Python: each job loads as a fresh module; <C>print()</C> is redirected into log events. Node: <C>console.*</C> is rewired to log events; jobs import via unique file URLs so every job is a fresh module.</Li>
      <Li>A workload error (exception in user code) is a normal, healthy outcome for the worker. A timeout, an unparseable line, or EOF kills the worker.</Li>
      <Li>
        <C>timeout_secs</C> wraps the whole read loop; on expiry the process (and, in sandbox modes, the container) is killed. Every spawned process is killed on drop, so server shutdown leaves no strays.
      </Li>
    </Ul>

    <H2 id="tiers">Isolation tiers</H2>
    <P>
      <C>LOOM_ISOLATION</C> selects how workers are spawned. All tiers speak the same protocol, so the orchestrator is oblivious to the choice.
    </P>
    <Table
      head={["Mode", "What runs", "Pool", "Use when"]}
      rows={[
        [<C key="m">process</C>, "Direct child processes of the server, as the server's user, using LOOM_PYTHON_BIN / LOOM_NODE_BIN.", "Yes (warm)", "Trusted, single-tenant, lowest latency. The default."],
        [<C key="m">container</C>, <>One <C>docker|podman run --rm -i</C> per job with <C>--network none</C>, a read-only rootfs plus a tmpfs <C>/tmp</C>, <C>--pids-limit</C>, <C>--memory</C>, and <C>--cpus</C> caps. The shim and job directories are mounted read-only at <C>/loom/shim</C> and <C>/loom/job</C>.</>, "Never", "Semi-trusted code, dependency isolation via images."],
        [<C key="m">microvm</C>, <>The same container invocation with <C>--runtime &lt;class&gt;</C> pointing at a VM-backed OCI runtime (Kata Containers, Firecracker via <C>kata-fc</C> / firecracker-containerd). Each job gets its own guest kernel.</>, "Never", "Untrusted or multi-tenant workloads."],
      ]}
    />
    <Code
      lang="bash"
      code={`LOOM_ISOLATION=container cargo run --release -p loom-server
LOOM_ISOLATION=microvm LOOM_VM_RUNTIME=io.containerd.kata.v2 cargo run --release -p loom-server`}
    />
    <Ul>
      <Li>
        Sandboxed workers have no network, so the in-task <C>loom</C> bindings cannot reach the API from inside a container unless you provide network access and a reachable <C>LOOM_API_URL</C> yourself.
      </Li>
      <Li>Host paths never leak into a sandbox: the job's entry path is rewritten to the guest mount.</Li>
      <Li>
        Timeouts kill the engine client <em>and</em> run <C>&lt;engine&gt; kill &lt;container&gt;</C>, so a wedged container or VM is not orphaned.
      </Li>
      <Li>
        Images, engine, memory, and CPU knobs are listed in <DocLink to="/docs/configuration#sandbox">Configuration</DocLink>.
      </Li>
    </Ul>

    <H2 id="pool">The warm worker pool</H2>
    <P>
      Starting an interpreter costs roughly 30 ms (CPython) to 115 ms (Node with TypeScript stripping) — more than most tasks themselves. In <C>process</C> mode the executor therefore keeps finished workers alive and feeds them subsequent jobs over the same stdin/stdout channel; the shims loop over requests. This is what makes ~1 ms function invocations and ~7 ms three-task workflows possible.
    </P>
    <Table
      head={["Rule", "Detail"]}
      rows={[
        ["Checkout", "Pops an idle worker or spawns one. A worker runs one job at a time."],
        ["Check-in", "Only after a clean protocol finish (result or in-workload error). Timeout, protocol violation, or EOF drops the worker instead."],
        ["Retirement", <>After <C>LOOM_WORKER_MAX_JOBS</C> (128) jobs, bounding interpreter-level accumulation such as Node's ESM module cache (every job is a unique module URL).</>],
        ["Parking", <>At most <C>LOOM_WORKER_MAX_IDLE</C> (8) idle workers per runtime.</>],
        ["Pools", <>One Python pool and one Node pool; Node starts with <C>--experimental-strip-types</C>, a no-op for plain JavaScript, so JS and TS share it.</>],
        ["Stale workers", "If handing a job to a parked worker fails (it died while idle), the executor retries once with a fresh spawn."],
        ["Disable", <><C>LOOM_WORKER_POOL=0</C> spawns a fresh process per job.</>],
      ]}
    />
    <H3 id="pool-implications">What sharing an interpreter means</H3>
    <P>
      Jobs share an interpreter but never a module: each job is loaded fresh from a unique path, so top-level state does not leak between jobs by design, while already-imported libraries stay warm (like a warm lambda). Code that mutates global interpreter state (monkey-patching, environment variables, working directory) can affect later jobs on the same worker. Workloads needing hard per-task isolation belong in <C>container</C> or <C>microvm</C> mode.
    </P>

    <H2 id="performance">Measured performance</H2>
    <P>Release build, SQLite store, real Python 3.11 / Node 22 workers, on a modest development container:</P>
    <Table
      head={["Operation", "p50 latency / throughput"]}
      rows={[
        ["Control-plane API call (GET /api/stats)", "0.6 ms"],
        ["Serverless invoke, Python", "1.2 ms"],
        ["Serverless invoke, JavaScript / TypeScript", "1.3 / 1.6 ms"],
        ["3-task workflow (py → py → js), end to end", "7.4 ms"],
        ["Sustained parallel invocations (32 concurrent)", "~775 invocations/s"],
        ["Streaming NDJSON ingestion", "~780 MB/s (1.7M records / 100 MB in 0.13 s)"],
      ]}
    />
    <Callout kind="note" title="Container and microVM latency">
      Sandbox modes pay the engine's start-up cost on every job (typically hundreds of milliseconds for containers, more for VMs) and are not represented in the table.
    </Callout>
  </>
);
