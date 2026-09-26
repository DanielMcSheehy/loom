// Notebook cell model helpers: templates, chaining inputs, dependency
// detection (for reactive re-runs), and output fingerprints (staleness).
import type { CellKind, NotebookCell, RuntimeName } from "../../types";

export const CODE_TEMPLATE: Record<RuntimeName, string> = {
  python:
    'def handler(params, inputs):\n    # inputs["prev"] is the output of the cell above; named cells add inputs["<name>"]\n    return {"hello": "world"}\n',
  typescript:
    'export function handler(params: Record<string, unknown>, inputs: Record<string, unknown>) {\n  // inputs.prev is the output of the cell above; named cells add inputs.<name>\n  return { hello: "world" };\n}\n',
  javascript:
    'export function handler(params, inputs) {\n  // inputs.prev is the output of the cell above; named cells add inputs.<name>\n  return { hello: "world" };\n}\n',
};

export const TRANSFORM_TEMPLATE: Record<RuntimeName, string> = {
  python:
    'def handler(params, inputs):\n    rows = inputs["prev"]\n    # transform the rows from the cell above\n    return [r for r in rows if r]\n',
  typescript:
    'export function handler(params: Record<string, unknown>, inputs: { prev: Record<string, unknown>[] }) {\n  const rows = inputs.prev;\n  // transform the rows from the cell above\n  return rows.slice(0, 10);\n}\n',
  javascript:
    'export function handler(params, inputs) {\n  const rows = inputs.prev;\n  // transform the rows from the cell above\n  return rows.slice(0, 10);\n}\n',
};

export const PLATFORM_TEMPLATE: Record<RuntimeName, string> = {
  python:
    'import loom\n\ndef handler(params, inputs):\n    # loom.query / loom.ingest / loom.invoke talk to the platform\n    rows = loom.query("SELECT COUNT(*) AS n FROM my_dataset")\n    return rows\n',
  typescript:
    'export async function handler(params: Record<string, unknown>, inputs: Record<string, unknown>) {\n  // loom.query / loom.ingest / loom.invoke talk to the platform\n  const rows = await loom.query("SELECT COUNT(*) AS n FROM my_dataset");\n  return rows;\n}\n',
  javascript:
    'export async function handler(params, inputs) {\n  // loom.query / loom.ingest / loom.invoke talk to the platform\n  const rows = await loom.query("SELECT COUNT(*) AS n FROM my_dataset");\n  return rows;\n}\n',
};

let seq = 0;
export const newCellId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;

export function makeCell(kind: CellKind, runtime: RuntimeName = "python", code?: string): NotebookCell {
  if (kind === "markdown") return { id: newCellId(), kind, code: code ?? "## Notes\n\nWrite **markdown** here.", output: null };
  if (kind === "sql") return { id: newCellId(), kind, code: code ?? "SELECT 1 AS one", output: null };
  return { id: newCellId(), kind, runtime, code: code ?? CODE_TEMPLATE[runtime], output: null };
}

/** The value a cell contributes to downstream inputs. */
export function outputValue(c: NotebookCell): unknown {
  if (c.kind === "markdown" || !c.output?.ok) return undefined;
  return c.output.rows ?? c.output.result;
}

/**
 * Outputs of successfully-run cells above this one, as the handler's second
 * argument: named cells keyed by name, plus `prev` = the nearest output.
 */
export function cellInputs(prior: NotebookCell[]): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  let prev: unknown;
  for (const c of prior) {
    const value = outputValue(c);
    if (value === undefined) continue;
    const name = c.name?.trim();
    if (name) inputs[name] = value;
    prev = value;
  }
  if (prev !== undefined) inputs.prev = prev;
  return inputs;
}

const REF_RE = /inputs\s*(?:\[\s*["']([\w-]+)["']\s*\]|\.get\(\s*["']([\w-]+)["']|\.([A-Za-z_]\w*))/g;

/** Names a code cell reads from `inputs` (`prev` and named cells). */
export function referencedNames(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of code.matchAll(REF_RE)) out.add(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Ids of the cells this cell's inputs come from. */
export function dependencies(cells: NotebookCell[], idx: number): string[] {
  const cell = cells[idx];
  if (!cell || cell.kind !== "code") return [];
  const names = referencedNames(cell.code);
  if (names.size === 0) return [];
  const prior = cells.slice(0, idx).filter((c) => c.kind !== "markdown");
  const deps: string[] = [];
  for (const name of names) {
    if (name === "prev") {
      const p = prior[prior.length - 1];
      if (p) deps.push(p.id);
      continue;
    }
    const named = [...prior].reverse().find((c) => c.name?.trim() === name);
    if (named) deps.push(named.id);
  }
  return [...new Set(deps)];
}

/** Cells (by index) below `idx` that transitively depend on it. */
export function dependents(cells: NotebookCell[], idx: number): number[] {
  const affected = new Set<string>([cells[idx].id]);
  const out: number[] = [];
  for (let i = idx + 1; i < cells.length; i++) {
    const deps = dependencies(cells, i);
    if (deps.some((d) => affected.has(d))) {
      affected.add(cells[i].id);
      out.push(i);
    }
  }
  return out;
}

export function fingerprint(code: string, inputs: unknown, extra = ""): string {
  const s = code + "\u0000" + JSON.stringify(inputs ?? null) + "\u0000" + extra;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function isStale(cells: NotebookCell[], idx: number): boolean {
  const c = cells[idx];
  if (c.kind === "markdown" || !c.output?.fingerprint) return false;
  const fp = c.kind === "sql" ? fingerprint(c.code, null, c.connector ?? "") : fingerprint(c.code, cellInputs(cells.slice(0, idx)));
  return fp !== c.output.fingerprint;
}

export function exportMarkdown(name: string, cells: NotebookCell[]): string {
  const out: string[] = [`# ${name}`, ""];
  for (const c of cells) {
    if (c.kind === "markdown") {
      out.push(c.code, "");
      continue;
    }
    const lang = c.kind === "sql" ? "sql" : c.runtime ?? "python";
    out.push(`\`\`\`${lang}${c.name ? ` title="${c.name}"` : ""}`, c.code.trimEnd(), "```", "");
    const v = outputValue(c);
    if (v !== undefined) {
      const rows = Array.isArray(v) ? v : null;
      if (rows && rows.length && typeof rows[0] === "object") {
        const cols = Object.keys(rows[0] as object);
        out.push(`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`);
        for (const r of rows.slice(0, 20)) out.push(`| ${cols.map((k) => String((r as Record<string, unknown>)[k] ?? "")).join(" | ")} |`);
        if (rows.length > 20) out.push(`| … ${rows.length - 20} more rows |`);
      } else {
        out.push("```json", JSON.stringify(v, null, 2).slice(0, 4000), "```");
      }
      out.push("");
    }
  }
  return out.join("\n");
}
