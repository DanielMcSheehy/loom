export type RunState = "pending" | "running" | "completed" | "failed" | "cancelled";
export type RuntimeName = "python" | "typescript" | "javascript";

export interface TaskSpec {
  id: string;
  name?: string | null;
  runtime: RuntimeName;
  code: string;
  depends_on: string[];
  params: unknown;
  timeout_secs: number;
  retries: number;
}

export interface WorkflowSpec {
  name: string;
  description?: string | null;
  params: unknown;
  tasks: TaskSpec[];
  triggers: { every_secs?: number | null; on_ingest?: string | null };
  max_parallel_tasks: number;
}

export interface Workflow {
  id: string;
  spec: WorkflowSpec;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  workflow_id: string;
  workflow_name: string;
  state: RunState;
  params: unknown;
  trigger: string;
  error?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface TaskRun {
  id: string;
  run_id: string;
  task_id: string;
  name: string;
  state: RunState;
  attempts: number;
  result?: unknown;
  error?: string | null;
  logs: string[];
  started_at?: string | null;
  finished_at?: string | null;
}

export interface LoomFunction {
  id: string;
  spec: {
    name: string;
    description?: string | null;
    runtime: RuntimeName;
    code: string;
    timeout_secs: number;
  };
  invocations: number;
  created_at: string;
  updated_at: string;
}

export interface Dataset {
  name: string;
  records: number;
  bytes: number;
  created_at: string;
  updated_at: string;
}

export interface Stats {
  workflows: number;
  functions: number;
  datasets: number;
  runs_total: number;
  runs_running: number;
  runs_completed: number;
  runs_failed: number;
  records_ingested: number;
  bytes_ingested: number;
}

export type ConnectorKind = "postgres" | "clickhouse" | "chdb";

export interface Connector {
  name: string;
  kind: ConnectorKind;
  url: string;
  created_at: string;
}

export type CellKind = "markdown" | "code" | "sql";

export interface NotebookCell {
  id: string;
  kind: CellKind;
  /** Optional user-facing name; cells below receive this cell's output as `inputs[name]`. */
  name?: string;
  runtime?: RuntimeName;
  connector?: string;
  code: string;
  /** Persisted last output so notebooks re-open with their results. */
  output?: CellOutput | null;
  chart?: ChartConfig | null;
  /** Which output tab is shown (table / chart / json). */
  view?: ResultViewKind;
  /** Editor hidden, output shown (Observable "unpinned" cell). */
  collapsed?: boolean;
}

export interface CellOutput {
  ok: boolean;
  result?: unknown;
  rows?: Array<Record<string, unknown>>;
  logs?: string[];
  error?: string;
  trace?: string;
  elapsed_ms?: number;
  /** When the cell ran (ISO). */
  ran_at?: string;
  /** Hash of the code + inputs the output was produced from, for staleness. */
  fingerprint?: string;
  truncated?: boolean;
  row_count?: number;
}

import type { ChartSpec } from "./components/charts/data";

export type ChartConfig = ChartSpec;

export type ResultViewKind = "table" | "chart" | "json";

export interface Notebook {
  id: string;
  name: string;
  cells: NotebookCell[] | null;
  /** Published: readable by anyone with the link, never runnable. */
  public?: boolean;
  created_at: string;
  updated_at: string;
}

export interface DatasetColumn {
  name: string;
  dtype: string;
  null_count: number;
  min?: unknown;
  max?: unknown;
  mean?: number | null;
  distinct?: number | null;
}

export interface DatasetProfile extends Dataset {
  columns: DatasetColumn[];
  sample: Array<Record<string, unknown>>;
  sample_size: number;
}

export type LoomEvent =
  | { type: "run_updated"; ts: string; run: Run }
  | { type: "task_updated"; ts: string; task: TaskRun }
  | { type: "log"; ts: string; run_id: string; task_id: string; line: string }
  | { type: "ingested"; ts: string; dataset: string; records: number; bytes: number }
  | { type: "function_invoked"; ts: string; name: string; ok: boolean; duration_ms: number };
