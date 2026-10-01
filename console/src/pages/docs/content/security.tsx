import { C, Callout, Code, DocLink, H2, Li, P, Table, Ul } from "../primitives";

export default (
  <>
    <Callout kind="warn" title="No authentication unless LOOM_PASSWORD is set">
      Out of the box there are no users, tokens, or roles: every route — including the ones that execute arbitrary Python and JavaScript on the server host — is open to anyone who can reach the port. Setting the <C>LOOM_PASSWORD</C> environment variable puts one shared password in front of the API, the MCP endpoint, and the console. It is a single credential for a trusted, single-tenant service — not user accounts, and not permissions.
    </Callout>

    <H2 id="password">Password auth (LOOM_PASSWORD)</H2>
    <P>
      Start the server with <C>LOOM_PASSWORD</C> set to a non-empty value and every <C>/api/*</C> route and <C>POST /mcp</C> requires the password. Unset or empty means auth is off and nothing changes. The variable is read once at start-up; change it by restarting.
    </P>
    <Code
      lang="bash"
      code={`LOOM_PASSWORD='a-long-random-string' ./target/release/loom-server

curl localhost:7420/api/workflows
# 401 {"error":"unauthorized"}

curl localhost:7420/api/workflows -H 'authorization: Bearer a-long-random-string'
# 200`}
    />
    <P>A request is authenticated by any one of:</P>
    <Table
      head={["Credential", "Used by", "Notes"]}
      rows={[
        [<C key="b">Authorization: Bearer &lt;password&gt;</C>, "SDKs, curl, MCP clients, workers", <>The password itself is the token. Both SDKs take a <C>token</C> option and default to the <C>LOOM_API_TOKEN</C> environment variable.</>],
        [<><C>loom_session</C> cookie</>, "The console", <>Minted by <C>POST /api/auth/login</C>: an opaque random token, <C>HttpOnly</C>, <C>SameSite=Lax</C>, and <C>Secure</C> when the request arrived over HTTPS (<C>x-forwarded-proto: https</C>). Sessions live in server memory — a restart logs every browser out.</>],
        [<C key="t">?token=&lt;password&gt;</C>, "Scripts using EventSource", <>Accepted <em>only</em> on the two SSE routes (<C>GET /api/events</C>, <C>GET /api/runs/{"{id}"}/events</C>), because EventSource cannot set headers. Query strings end up in proxy logs — prefer the header where you can.</>],
      ]}
    />
    <P>
      Anything else gets <C>401 {`{"error": "unauthorized"}`}</C>. Three things stay open: <C>GET /api/healthz</C> (liveness probes), the <C>/api/auth/*</C> endpoints, and the console's static files — the single-page app loads, asks <C>GET /api/auth/status</C>, and shows a login screen. Nothing sensitive is in the static bundle.
    </P>
    <Ul>
      <Li>
        <strong>Logging in.</strong> Wrong passwords are rate-limited per client address: five quick attempts, then one every two seconds (<C>429</C> with <C>Retry-After</C>). Behind a reverse proxy every visitor shares the proxy's address, so the limit is shared too. The password is compared in constant time.
      </Li>
      <Li>
        <strong>Bearer requests are not rate-limited.</strong> The password doubles as the API token, so make it long and random (for example <C>openssl rand -base64 32</C>), not something memorable.
      </Li>
      <Li>
        <strong>Workers.</strong> The server hands its own workers the credential as <C>LOOM_API_TOKEN</C> so the in-task <C>loom.query / ingest / invoke</C> bindings keep working. Task, function, and notebook code can therefore read the password from its environment — anyone allowed to run code already has it.
      </Li>
      <Li>
        <strong>Use HTTPS.</strong> The password and the session cookie travel in request headers. Terminate TLS in front of Loom (a reverse proxy or a platform such as Coolify); over plain HTTP anyone on the path can read them.
      </Li>
    </Ul>

    <H2 id="published">Published notebooks</H2>
    <P>
      A logged-in user can <strong>publish</strong> a notebook from its header (<DocLink to="/docs/notebooks">Notebooks</DocLink>). A published notebook is readable without a password by anyone who has its link:
    </P>
    <Ul>
      <Li>
        <C>GET /api/notebooks/{"{id}"}</C> returns the document — every cell's source and its <em>stored</em> output (result rows, logs, charts) — and <C>GET /api/notebooks?public=1</C> lists the published notebooks. The console renders the link as a read-only page.
      </Li>
      <Li>
        <strong>Reading is all it grants.</strong> A visitor cannot run cells, query datasets, or change anything: <C>/api/execute</C>, <C>/api/query</C>, <C>PUT</C>/<C>DELETE</C> on the notebook, and every other route still answer <C>401</C>.
      </Li>
      <Li>
        Private notebooks answer <C>401</C>, never <C>404</C>, so a visitor cannot tell a private notebook from one that does not exist. Ids are random UUIDs.
      </Li>
      <Li>
        <strong>Check the outputs before publishing.</strong> Whatever a cell last returned or printed is public with it — including rows from private datasets, connector results, and anything a cell logged. Unpublish at any time; the link stops working immediately.
      </Li>
    </Ul>

    <H2 id="threat-model">Without a password</H2>
    <Ul>
      <Li>
        Anyone with network access can create workflows and functions, call <C>POST /api/execute</C>, read every dataset, query registered connectors (whose URLs, including passwords, are stored and returned in plaintext), and delete anything.
      </Li>
      <Li>CORS is permissive, so a browser page on any origin can call the API of a reachable server.</Li>
      <Li>The console, the SDKs, and the MCP endpoint all inherit this: registering the MCP server with an agent gives that agent the same unrestricted access.</Li>
    </Ul>
    <P>
      That is fine on a laptop or a private network, which is what the default is for. Do not expose port 7420 to the internet without <C>LOOM_PASSWORD</C> (or another authenticating proxy in front).
    </P>

    <H2 id="limits">What the password does not do</H2>
    <Ul>
      <Li>
        <strong>No users or roles.</strong> Everyone with the password can do everything, and there is no audit trail of who did what. Rotate it by restarting with a new value.
      </Li>
      <Li>
        <strong>No sandboxing.</strong> In the default <C>process</C> isolation mode, user code runs as the server's OS user with the server's network access, environment, and filesystem. For code you do not fully trust, raise the tier: <C>LOOM_ISOLATION=container</C> gives each job a no-network, read-only sandbox with resource caps; <C>microvm</C> adds a per-job kernel. See <DocLink to="/docs/isolation">Isolation</DocLink>.
      </Li>
      <Li>
        <strong>No encryption at rest.</strong> <C>LOOM_DATA_DIR</C> holds the SQLite store (workflow code, run results and logs, connector URLs) and every ingested dataset. Protect the directory.
      </Li>
      <Li>
        <strong>Connectors pass SQL through verbatim.</strong> Register Postgres and ClickHouse connectors with read-only, least-privilege credentials.
      </Li>
    </Ul>

    <H2 id="not-mitigations">Things that are not access control</H2>
    <P>
      Name validation (<C>[a-zA-Z0-9_-]{"{1,64}"}</C>) prevents path traversal in dataset, function, and connector names; DAG validation prevents malformed workflows; timeouts and the pool's job limits keep runaway code from wedging the server. None of these restrict <em>who</em> can do <em>what</em>.
    </P>
    <P>
      The "no authentication unless <C>LOOM_PASSWORD</C> is set" caveat also appears in the README and the deployment notes; keep it there when editing those documents.
    </P>
  </>
);
