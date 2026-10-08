import { C, Callout, Code, DocLink, H2, P, Table } from "../primitives";

const row = (name: string, def: string, desc: React.ReactNode) => [<C key="n">{name}</C>, <C key="d">{def}</C>, desc];

export default (
  <>
    <P>Loom is configured entirely through environment variables read at start-up. There is no config file.</P>

    <H2 id="server">Server</H2>
    <Table
      head={["Variable", "Default", "Meaning"]}
      rows={[
        row("LOOM_PORT", "7420", "TCP port for the API, MCP endpoint, and console. Binds 0.0.0.0."),
        row("LOOM_DATA_DIR", "./data", <>Created if missing. Holds <C>loom.db</C> (SQLite, WAL mode) and <C>datasets/*.ndjson</C>.</>),
        row("LOOM_CONSOLE_DIST", "./console/dist", <>Built console to serve as a single-page app. Skipped silently when <C>index.html</C> is absent (API only).</>),
        row("LOOM_PASSWORD", "unset", <>Shared password for the API, the MCP endpoint, and the console. Unset or empty means <strong>no authentication</strong>: every route is open. When set, requests need <C>Authorization: Bearer &lt;password&gt;</C> or a console login; published notebooks stay readable. See <DocLink to="/docs/security">Security</DocLink>.</>),
        row("LOOM_API_URL", "http://127.0.0.1:<port>", <>Base URL workers use for the in-task <C>loom</C> bindings. Set automatically when unset; override if workers run on another host or in containers that cannot reach the loopback address.</>),
        row("LOOM_API_TOKEN", "= LOOM_PASSWORD", <>Set by the server for its workers when <C>LOOM_PASSWORD</C> is set, so the in-task <C>loom</C> bindings authenticate. Not something you configure on the server; the SDKs read the same variable as their default <C>token</C>.</>),
        row("RUST_LOG", "info", <>Log filter (<C>tracing_subscriber</C> env-filter syntax), e.g. <C>loom_server=debug</C>.</>),
      ]}
    />

    <H2 id="executor">Executor and worker pool</H2>
    <Table
      head={["Variable", "Default", "Meaning"]}
      rows={[
        row("LOOM_ISOLATION", "process", <><C>process</C> | <C>container</C> | <C>microvm</C>. Any other value fails start-up. See <DocLink to="/docs/isolation">Isolation</DocLink>.</>),
        row("LOOM_SITE_DIR", "./site", "Static landing page (site/) served at /landing without auth. Skipped when the directory has no index.html."),
        row("LOOM_PYTHON_BIN", "python3", "Interpreter for Python workers (process mode). Handlers can import whatever is installed for it. The Docker image sets /opt/loom-py/bin/python3, a venv with numpy, pandas, scipy, and scikit-learn."),
        row("LOOM_NODE_BIN", "node", "Binary for JavaScript/TypeScript workers (process mode). TypeScript needs Node 22+."),
        row("LOOM_WORKER_POOL", "1", <>Set to <C>0</C> to disable the warm pool and spawn a fresh process per job (process mode only; container/microVM never pool).</>),
        row("LOOM_WORKER_MAX_IDLE", "8", "Warm workers kept parked per runtime (one Python pool, one Node pool)."),
        row("LOOM_WORKER_MAX_JOBS", "128", "A worker retires after this many jobs, bounding interpreter-level accumulation such as Node's ESM module cache."),
      ]}
    />

    <H2 id="sandbox">Container and microVM modes</H2>
    <P>Read only when <C>LOOM_ISOLATION</C> is <C>container</C> or <C>microvm</C>.</P>
    <Table
      head={["Variable", "Default", "Meaning"]}
      rows={[
        row("LOOM_CONTAINER_ENGINE", "docker", <>Engine CLI: <C>docker</C> or <C>podman</C>.</>),
        row("LOOM_VM_RUNTIME", "unset · kata in microvm", <>OCI runtime class passed as <C>--runtime</C>. Unset means the engine default in container mode; <C>microvm</C> mode defaults to <C>kata</C>. Examples: <C>io.containerd.kata.v2</C>, <C>kata-fc</C>.</>),
        row("LOOM_PYTHON_IMAGE", "python:3.12-slim", "Image for Python workers."),
        row("LOOM_NODE_IMAGE", "node:22-slim", "Image for JS/TS workers."),
        row("LOOM_WORKER_MEMORY", "512m", <>Per-worker memory cap (<C>--memory</C>).</>),
        row("LOOM_WORKER_CPUS", "1", <>Per-worker CPU quota (<C>--cpus</C>).</>),
      ]}
    />

    <H2 id="examples">Examples</H2>
    <Code
      lang="bash"
      code={`# production-ish: password, fixed data dir, built console, quieter logs
LOOM_PASSWORD="$(openssl rand -base64 32)" \\
LOOM_PORT=7420 LOOM_DATA_DIR=/srv/loom LOOM_CONSOLE_DIST=/srv/loom/console RUST_LOG=warn \\
  ./target/release/loom-server

# containers per task
LOOM_ISOLATION=container LOOM_WORKER_MEMORY=1g cargo run --release -p loom-server

# microVMs (requires a VM runtime registered with the engine)
LOOM_ISOLATION=microvm LOOM_VM_RUNTIME=io.containerd.kata.v2 cargo run --release -p loom-server

# a specific interpreter, no warm pool
LOOM_PYTHON_BIN=/opt/venv/bin/python LOOM_WORKER_POOL=0 cargo run --release -p loom-server`}
    />
    <Callout kind="note" title="Docker Compose">
      The repository's <C>docker-compose.yml</C> runs the server with the console built in and a <C>loom-data</C> volume for <C>LOOM_DATA_DIR</C>; <C>docker-compose.coolify.yml</C> adds the Coolify routing variable. Unless <C>LOOM_PASSWORD</C> is set in the service's environment, both expose it without authentication — see <DocLink to="/docs/security">Security</DocLink>.
    </Callout>
  </>
);
