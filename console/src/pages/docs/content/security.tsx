import { C, Callout, DocLink, H2, Li, P, Ul } from "../primitives";

export default (
  <>
    <Callout kind="warn" title="Loom has no authentication">
      There are no users, tokens, API keys, or roles. Every route — including ones that execute arbitrary Python and JavaScript on the server host — is open to anyone who can reach the port. This is by design: Loom is a trusted, single-tenant service.
    </Callout>

    <H2 id="threat-model">What that means</H2>
    <Ul>
      <Li>
        Anyone with network access can create workflows and functions, call <C>POST /api/execute</C>, read every dataset, query registered connectors (whose URLs, including passwords, are stored and returned in plaintext), and delete anything.
      </Li>
      <Li>
        In the default <C>process</C> isolation mode, user code runs as the server's OS user with the server's network access, environment, and filesystem.
      </Li>
      <Li>CORS is permissive, so a browser page on any origin can call the API of a reachable server.</Li>
      <Li>The console, the SDKs, and the MCP endpoint all inherit this: registering the MCP server with an agent gives that agent the same unrestricted access.</Li>
    </Ul>

    <H2 id="deploying">Deploying safely</H2>
    <Ul>
      <Li>
        <strong>Keep it internal.</strong> Bind behind a private network, VPN, or SSH tunnel. Do not expose port 7420 to the internet as-is.
      </Li>
      <Li>
        <strong>Front it if it must be shared.</strong> Put a reverse proxy with its own authentication (or a platform's access controls, such as Coolify's) in front of the whole port. Remember that SSE and long-running ingest bodies must pass through unbuffered.
      </Li>
      <Li>
        <strong>Raise the isolation tier</strong> for code you do not fully trust: <C>LOOM_ISOLATION=container</C> gives each job a no-network, read-only sandbox with resource caps; <C>microvm</C> adds a per-job kernel. See <DocLink to="/docs/isolation">Isolation</DocLink>.
      </Li>
      <Li>
        <strong>Protect the data directory.</strong> <C>LOOM_DATA_DIR</C> contains the SQLite store (workflow code, run results and logs, connector URLs) and every ingested dataset.
      </Li>
      <Li>
        <strong>Least-privilege connectors.</strong> Register Postgres and ClickHouse connectors with read-only credentials; the query route passes SQL through verbatim.
      </Li>
    </Ul>

    <H2 id="not-mitigations">Things that are not access control</H2>
    <P>
      Name validation (<C>[a-zA-Z0-9_-]{"{1,64}"}</C>) prevents path traversal in dataset, function, and connector names; DAG validation prevents malformed workflows; timeouts and the pool's job limits keep runaway code from wedging the server. None of these restrict <em>who</em> can do <em>what</em>.
    </P>
    <P>
      This caveat also appears in the README and the deployment notes; keep it there when editing those documents.
    </P>
  </>
);
