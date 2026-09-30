// Docs page registry — metadata only (titles, slugs, sections). Kept free of
// page bodies so the command palette can list docs pages without pulling the
// content bundle into the main chunk; bodies live in `content/` and are
// loaded lazily by `Docs.tsx`.

export interface DocPageMeta {
  slug: string;
  title: string;
  /** One line shown in the nav filter, the overview grid, and the palette. */
  summary: string;
  section: string;
  /** Extra search terms not present in the title/summary. */
  keywords?: string;
}

export const DOC_SECTIONS = ["Get started", "Guides", "Integrations", "Reference"] as const;

export const DOC_PAGES: DocPageMeta[] = [
  { slug: "overview", title: "Overview", summary: "Concepts: workflows, tasks, runs, the state machine, triggers.", section: "Get started", keywords: "concepts introduction what is loom" },
  { slug: "quickstart", title: "Quickstart", summary: "Run the server and ship a first workflow with curl, Python, or TypeScript.", section: "Get started", keywords: "install getting started first workflow" },
  { slug: "workflows", title: "Workflows & DAGs", summary: "handler(params, inputs), parameter merging, retries, timeouts, and triggers.", section: "Guides", keywords: "dag task depends_on retries timeout every_secs on_ingest merge_params" },
  { slug: "runs", title: "Runs & events", summary: "Run lifecycle, cancellation, and the live SSE event stream.", section: "Guides", keywords: "sse events run_updated task_updated log cancel" },
  { slug: "functions", title: "Functions", summary: "Deploy named handlers and invoke them over HTTP, with optional streamed logs.", section: "Guides", keywords: "serverless invoke stream" },
  { slug: "data", title: "Data ingest & datasets", summary: "Streaming NDJSON ingestion, naming rules, and column profiles.", section: "Guides", keywords: "ingest ndjson dataset profile describe" },
  { slug: "sql", title: "SQL & connectors", summary: "Query datasets with the embedded Polars engine, or route to Postgres, ClickHouse, and chDB.", section: "Guides", keywords: "query polars connector postgres clickhouse chdb" },
  { slug: "notebooks", title: "Notebooks", summary: "Markdown, code, and SQL cells that chain through inputs, with charts and typed autocomplete.", section: "Guides", keywords: "cell prev inputs reactive chart insert types autocomplete" },
  { slug: "mcp", title: "MCP server", summary: "Every tool the Model Context Protocol endpoint exposes to AI agents, with arguments.", section: "Integrations", keywords: "model context protocol agent claude tools" },
  { slug: "sdk-python", title: "Python SDK", summary: "loom_sdk: @task, Flow, and LoomClient — zero dependencies.", section: "Integrations", keywords: "python loom_sdk client flow task" },
  { slug: "sdk-typescript", title: "TypeScript SDK", summary: "@loom/sdk: task(), flow(), and LoomClient on fetch — zero dependencies.", section: "Integrations", keywords: "typescript javascript node sdk client" },
  { slug: "api", title: "REST API reference", summary: "Every HTTP route: method, path, request body, response shape, and a curl example.", section: "Reference", keywords: "http endpoints routes curl rest" },
  { slug: "configuration", title: "Configuration", summary: "All LOOM_* environment variables and their defaults.", section: "Reference", keywords: "env environment variables port data dir" },
  { slug: "isolation", title: "Isolation & worker pool", summary: "Process, container, and microVM tiers; how the warm pool reuses interpreters.", section: "Reference", keywords: "docker podman kata firecracker pool workers" },
  { slug: "security", title: "Security", summary: "No authentication: Loom is a trusted single-tenant service by design.", section: "Reference", keywords: "auth authentication trust deploy expose" },
];

export const pageBySlug = (slug: string) => DOC_PAGES.find((p) => p.slug === slug);
