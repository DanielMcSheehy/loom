import { Link } from "react-router-dom";
import { ROUTE_GROUPS } from "../api-routes";
import { C, Callout, Code, DocLink, Endpoint, H2, Inline, MethodBadge, P, routeId, Table } from "../primitives";

export default (
  <>
    <H2 id="conventions">Conventions</H2>
    <Table
      head={["Topic", "Rule"]}
      rows={[
        ["Base path", <>All REST routes live under <C>/api</C>; the MCP endpoint is <C>/mcp</C>. Default port <C>7420</C>.</>],
        ["Bodies", <>JSON with <C>content-type: application/json</C>, except ingestion, which takes raw NDJSON.</>],
        ["Errors", <>Every non-2xx response is <C>{`{"error": "message"}`}</C>. <C>400</C> for validation and query errors, <C>404</C> for unknown ids/names (<C>not found: workflow &lt;id&gt;</C>), <C>409</C> for cancelling a finished run, <C>500</C> for storage or I/O failures.</>],
        ["Ids", "Workflows, runs, and notebooks are addressed by UUID; functions, datasets, and connectors by name."],
        ["Timestamps", "RFC 3339 UTC strings, e.g. 2026-09-30T10:00:00.120Z."],
        ["Execution results", <><C>invoke</C> and <C>execute</C> return <C>200</C> even when the user code fails; inspect <C>ok</C>.</>],
        ["CORS", "Permissive (any origin)."],
        ["Authentication", <>None. See <DocLink to="/docs/security">Security</DocLink>.</>],
      ]}
    />
    <Code
      lang="json"
      title="Error shape"
      code={`HTTP/1.1 404 Not Found
content-type: application/json

{ "error": "not found: workflow 6f1c…" }`}
    />

    <H2 id="index">All routes</H2>
    <div className="doc-routes">
      {ROUTE_GROUPS.flatMap((g) =>
        g.routes.map((r) => (
          <Link key={`${r.method} ${r.path}`} to={`#${routeId(r)}`} className="doc-route-row">
            <MethodBadge method={r.method} />
            <code>{r.path}</code>
            <span className="sum">{r.summary}</span>
          </Link>
        )),
      )}
    </div>

    {ROUTE_GROUPS.map((g) => (
      <div key={g.id}>
        <H2 id={g.id}>{g.title}</H2>
        {g.intro && <P><Inline>{g.intro}</Inline></P>}
        {g.routes.map((r) => (
          <Endpoint key={`${r.method} ${r.path}`} route={r} />
        ))}
      </div>
    ))}

    <Callout kind="note" title="Examples assume">
      <C>WF</C>, <C>RUN</C>, and <C>NB</C> shell variables holding ids from earlier responses, a server on <C>localhost:7420</C>, and — for the Python and TypeScript tabs — a constructed <C>client</C> as shown on the SDK pages.
    </Callout>
  </>
);
