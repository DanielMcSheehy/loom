# Loom — agent guide

Rust-native orchestration platform for Python/TypeScript workloads: workflow
DAGs, serverless functions, streaming NDJSON ingestion, embedded SQL (Polars),
notebooks, and an MCP server — one binary, SQLite inside.

## Map

| Path | What lives there | Scoped guide |
| --- | --- | --- |
| `crates/` | Rust workspace: core → store/executor → server | `crates/AGENTS.md` |
| `crates/loom-executor/` | worker processes, wire protocol, pool, isolation | `crates/loom-executor/AGENTS.md` |
| `console/` | React + Vite UI | `console/AGENTS.md` |
| `sdks/` | zero-dependency Python + TypeScript clients | `sdks/AGENTS.md` |
| `site/` | landing page + docs (self-contained HTML, no build) | — |
| `docs/` | architecture notes, dev-environment guide (`development.md`), screenshots | — |
| `examples/` | runnable pipelines against a live server | — |

## Commands

```bash
cargo test --workspace                 # all Rust tests (spawns real python3/node workers)
cargo clippy --workspace --all-targets # CI gates on -D warnings
cargo run --release -p loom-server   # API + console on :7420
cd console && npm run build            # tsc -b && vite build (build IS the typecheck)
cd sdks/typescript && npm run build
python3 examples/python_pipeline.py    # e2e smoke (needs running server)
```

Server env: `LOOM_PORT` (7420), `LOOM_DATA_DIR` (./data),
`LOOM_CONSOLE_DIST` (./console/dist), `LOOM_ISOLATION`
(process|container|microvm), `LOOM_WORKER_POOL` (=0 disables),
`LOOM_WORKER_MAX_IDLE` (8), `LOOM_WORKER_MAX_JOBS` (128),
`LOOM_PYTHON_BIN`/`LOOM_NODE_BIN`, `LOOM_API_URL` (injected for workers).

## Cross-cutting contracts (breaking any of these breaks users)

- **Run/TaskRun state machine**: `pending → running → completed|failed|cancelled`.
  Terminal states never transition again. A failed task fails the run; tasks
  never reached are marked `cancelled`.
- **Task handler signature**: `handler(params, inputs)` — `params` = run params
  merged with task params (overlay wins, `null` keeps base — see
  `orchestrator::merge_params`), `inputs` = `{upstream_task_id: result}`.
  This is public API across both SDKs, the shims, docs, and the console.
- **API error shape**: non-2xx responses are `{"error": "message"}`.
- **Event stream**: every state change / log line / ingest / invocation emits a
  `LoomEvent` (serde-tagged `type`, snake_case) on the broadcast bus; SSE
  endpoints are dumb subscribers. New observable behavior ⇒ new event variant.
- **Worker wire protocol**: JSON-lines over stdio, defined in
  `crates/loom-executor/AGENTS.md`. Changing it touches shims, executor,
  and pool simultaneously.
- **SDK parity**: any new HTTP endpoint gets a method in BOTH
  `sdks/python` and `sdks/typescript`, plus README examples.

## Rules

- **Verify like this session did**: unit tests + a live e2e (curl or SDK
  script against a running release server). UI changes get a real-browser
  Playwright screenshot before they're called done.
- **Auth is a single shared password.** `LOOM_PASSWORD` unset ⇒ wide open
  (trusted single-tenant); set ⇒ every `/api/*` and `/mcp` request needs
  `Authorization: Bearer <password>`, the `loom_session` cookie, or `?token=`
  on SSE. Only `/api/healthz`, `/api/auth/*`, and *published* notebooks
  (`public: true`, read-only) are open. New routes are protected by default;
  never add an unauthenticated route that can execute code or read non-public
  data. Keep the "unset = open, don't expose it" caveat in README/deploy docs.
- **Polars is pinned to 0.51** — 0.54+ needs nightly rustc features. Don't bump
  without checking `cargo check` on stable.
- **Rust edition stays 2021** — `main.rs` uses `std::env::set_var` (unsafe in 2024).
- **SDKs stay zero-dependency** (Python stdlib / global fetch only).
- **Dataset & function & connector names**: `[a-zA-Z0-9_-]{1,64}` (`is_safe_name`).
- Benchmarks quoted anywhere (README, landing page) must be *measured*, with
  the environment stated. Update `site/index.html` stats if they change.
