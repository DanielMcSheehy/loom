// What a handler will receive: the `params` value and the named `inputs`
// a surface knows about (prior notebook cells, upstream tasks). Surfaces
// build a `TypeContext`; the editor resolves it to shapes once per identity.
// Pure and tiny: pages import this from the main bundle, so it must not
// pull in CodeMirror or the inference code (see `resolved.ts` for that).

export interface TypeContextInput {
  name: string;
  /** `undefined` = known name, unknown value (e.g. a cell that has not run). */
  value?: unknown;
  /** Human label for docs: "cell 2 · sql", "task extract · run 3f1a…". */
  source?: string;
}

export interface TypeContext {
  /** Value of `params`; `undefined` when nothing is known. */
  params?: unknown;
  paramsSource?: string;
  inputs: TypeContextInput[];
  /** Where `inputs` as a whole comes from, for the root hover. */
  inputsSource?: string;
}

/**
 * Mirror of the server's `orchestrator::merge_params`: objects merge key by
 * key (overlay wins), a `null` overlay keeps the base, anything else replaces.
 */
export function mergeParams(base: unknown, overlay: unknown): unknown {
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  if (isObj(base) && isObj(overlay)) return { ...base, ...overlay };
  if (overlay === null || overlay === undefined) return base;
  return overlay;
}

/**
 * Keep a context's identity stable while its key is unchanged, so editors
 * are not told to re-resolve on every unrelated re-render (keystrokes in
 * other cells, spec edits). `key` must change whenever the inputs do.
 */
export class ContextCache {
  private entries = new Map<string, { key: string; ctx: TypeContext }>();

  get(id: string, key: string, build: () => TypeContext): TypeContext {
    const hit = this.entries.get(id);
    if (hit && hit.key === key) return hit.ctx;
    const ctx = build();
    this.entries.set(id, { key, ctx });
    return ctx;
  }

  prune(liveIds: Iterable<string>) {
    const keep = new Set(liveIds);
    for (const id of this.entries.keys()) if (!keep.has(id)) this.entries.delete(id);
  }
}
