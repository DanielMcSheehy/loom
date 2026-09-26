# Console (React + Vite)

```bash
npm run dev        # :3001, proxies /api → :7420
npm run build      # tsc -b && vite build — the build IS the typecheck
```

## Design system — the rules that keep it looking like one product

- **CSS custom properties only** (`src/styles.css`). Tokens are defined on
  `:root` (light) and overridden under `:root[data-theme="dark"]`; `theme.ts`
  sets the attribute (explicit choice in localStorage, else the OS scheme).
  Never hardcode a hex in a component; SVG fills use `var(--…)` too.
- **Neutral chrome, one accent.** Surfaces are neutral greys (`--bg`,
  `--surface`, `--surface-2/3/4`), ink is `--ink/--ink-2/3/4`, the single
  accent is blue (`--accent`). No gradients, no glows.
- **Pop is concentrated** in status, data, and interactive elements (pills,
  charts, DAG, buttons). Tables, labels, and body text stay quiet.
- **State → colour is fixed everywhere**: completed=`--good`,
  running=`--running` (animated), failed=`--critical`, pending/cancelled
  muted. Runtime badges: `--py/--ts/--js`.
- **Charts use the categorical palette `--s1…--s8`** in fixed slot order
  (validated for colour-vision deficiency in both themes); more than eight
  series fold into "Other". Charts that encode run state pass a `colors`
  map so state colours stay fixed. Marks: bars ≤ 24px with a 4px rounded
  data end, 2px lines, ≥ 8px markers with a surface ring, hairline grid.
- **Radii**: `--r-sm` (6, inputs/buttons), `--r` (10, cards/cells),
  `--r-lg` (14, dialogs). Don't invent others.
- Icons come from `@phosphor-icons/react` only; no hand-drawn SVG icons.

## Patterns

- HTTP via `api.ts` helpers; errors surface the server's `{"error"}` message.
- **Live data**: subscribe with `useEvents((ev) => ...)` (SSE); merge updates
  into lists by id (find index → replace, prepend if new). Pages should not
  poll except run-completion waits.
- **CodeEditor vs CodeBlock split is load-bearing**: `CodeEditor.tsx` is a
  lazy wrapper (React.lazy) around `CodeMirrorEditor.tsx` so the ~229KB gzip
  CM6 chunk stays out of the main bundle (~82KB gzip). Read-only code uses
  Prism (`CodeBlock.tsx`). Never import `CodeMirrorEditor` statically from
  anything in the main graph.
- DAG rendering (`DagGraph.tsx`) mirrors the server's Kahn layering. Edge
  classes: `active` (upstream done → downstream running, animated marching
  dashes), `done` (hop completed), plain otherwise.
- Notebook cells are client-owned JSON (`NotebookCell` in `types.ts`); the
  server stores them opaquely. Cell execution = `/api/execute` (code) or
  `/api/query` (sql). Code cells chain: `cellInputs()` collects outputs of
  cells above (named cells keyed by name + `prev`) and sends them as
  `inputs`. Outputs, chart specs (`ChartSpec`), the active output tab, and
  code-collapsed state persist with the document.
- **Reactive notebooks** (`components/notebook/cells.ts`): `dependencies()`
  parses `inputs["name"]` / `inputs.name` / `inputs.prev` references to find
  the cells a code cell reads from; `dependents()` walks downstream. The
  editor keeps a sequential run queue (`pump()` in `NotebookEditor.tsx`) and,
  in reactive mode, enqueues dependents after a successful run. Outputs
  carry a `fingerprint` of code + inputs so `isStale()` can flag cells whose
  inputs changed.
- **Results**: `ResultView` routes tabular values to `DataGrid` (column
  summaries, sort, filter, paging, CSV/JSON) and `charts/ChartBuilder`
  (spec editor around `charts/Chart.tsx`, an SVG renderer with hover
  tooltips and legends); everything else to `JsonView`. Column inference
  and series preparation live in `charts/data.ts` and take plain row arrays.
- The cell picker (`CellInserter.tsx`) is the "+" between cells: kinds up
  top, then searchable templates built from the dataset list.
- Pages publish breadcrumbs with `useCrumbs()`; `CommandPalette.tsx` (⌘K)
  lists pages, actions, and every workflow / notebook / function / dataset.
- `WorkflowBuilder.tsx` is the create/edit surface for workflows (Workflows
  page + WorkflowDetail edit): structured form ↔ JSON tab over the same
  `WorkflowSpec`; task cards address tasks by index so id edits don't
  remount (and drop focus on) the card.

## Verification rule

UI changes are not done until seen: build, serve via the release server
(`LOOM_CONSOLE_DIST=console/dist`), drive with Playwright (`npm i playwright
&& npx playwright install chromium` in a scratch dir; `waitUntil: "load"` —
SSE keeps `networkidle` from ever firing), screenshot **both themes**
(`localStorage.loom.theme = "light" | "dark"` in an init script), and look at
it. Interactive features (editors, live progress, drag) get a behavioral
check (type/click, assert), not just a render. Remember Playwright's mouse
does not scroll: `scrollIntoViewIfNeeded()` before dragging off-screen cells.
