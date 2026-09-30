// Resolve a `TypeContext` into shapes once per identity. Lives in the
// editor chunk (imported by the CodeMirror extension), not the main bundle.
import { type TypeContext } from "./context";
import { infer, type Shape, UNKNOWN } from "./shape";

export interface ResolvedContext {
  params: Shape;
  paramsSource?: string;
  inputs: Shape;
  inputsSource?: string;
  /** Raw values for sample text, keyed by root then input name. */
  values: { params: unknown; inputs: Record<string, unknown> };
}

const cache = new WeakMap<TypeContext, ResolvedContext>();

export function resolveContext(ctx: TypeContext): ResolvedContext {
  const hit = cache.get(ctx);
  if (hit) return hit;
  const fields: Record<string, { shape: Shape; optional: boolean; source?: string }> = {};
  const values: Record<string, unknown> = {};
  for (const inp of ctx.inputs) {
    if (!inp.name) continue;
    fields[inp.name] = { shape: inp.value === undefined ? UNKNOWN : infer(inp.value), optional: false, source: inp.source };
    values[inp.name] = inp.value;
  }
  const out: ResolvedContext = {
    params: ctx.params === undefined ? UNKNOWN : infer(ctx.params),
    paramsSource: ctx.paramsSource,
    inputs: { kind: "object", fields, truncated: false },
    inputsSource: ctx.inputsSource,
    values: { params: ctx.params, inputs: values },
  };
  cache.set(ctx, out);
  return out;
}
