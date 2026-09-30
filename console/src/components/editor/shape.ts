// Structural type inference over JSON values, for editor completion and
// hover. Pure and dependency-free: values in → a small `Shape` tree out,
// rendered as TypeScript or Python type text plus a short sample.
//
// Arrays are sampled (first SAMPLE elements) and their element shapes
// merged: keys missing in some rows become optional, differing primitive
// kinds become unions. Depth and key counts are capped so a huge output
// never stalls the UI, and inference is memoized per object identity so
// repeated completions on the same output are O(1).

export type PrimitiveType = "string" | "number" | "integer" | "boolean";

export type Shape =
  | { kind: "primitive"; type: PrimitiveType }
  | { kind: "null" }
  | { kind: "unknown" }
  | { kind: "array"; element: Shape; length: number }
  | { kind: "object"; fields: Record<string, Field>; truncated: boolean }
  | { kind: "union"; members: Shape[] };

export interface Field {
  shape: Shape;
  optional: boolean;
  /** Where the value came from (e.g. "cell 2 · sql"); only set on root inputs. */
  source?: string;
}

export const LIMITS = { depth: 8, keys: 80, sample: 200 } as const;

export const UNKNOWN: Shape = { kind: "unknown" };
export const NULL: Shape = { kind: "null" };

const memo = new WeakMap<object, Shape>();

/** Infer the shape of a JSON-ish value. Memoized per object identity. */
export function infer(value: unknown): Shape {
  if (value !== null && typeof value === "object") {
    const hit = memo.get(value);
    if (hit) return hit;
    const s = inferAt(value, 0);
    memo.set(value, s);
    return s;
  }
  return inferAt(value, 0);
}

function inferAt(value: unknown, depth: number): Shape {
  if (value === null) return NULL;
  switch (typeof value) {
    case "string":
      return { kind: "primitive", type: "string" };
    case "number":
      return { kind: "primitive", type: Number.isInteger(value) ? "integer" : "number" };
    case "boolean":
      return { kind: "primitive", type: "boolean" };
    case "object":
      break;
    default:
      return UNKNOWN;
  }
  if (depth >= LIMITS.depth) return UNKNOWN;
  if (Array.isArray(value)) {
    let element: Shape = UNKNOWN;
    const n = Math.min(value.length, LIMITS.sample);
    for (let i = 0; i < n; i++) element = merge(element, inferAt(value[i], depth + 1));
    return { kind: "array", element, length: value.length };
  }
  const fields: Record<string, Field> = {};
  const keys = Object.keys(value as object);
  const n = Math.min(keys.length, LIMITS.keys);
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    fields[k] = { shape: inferAt((value as Record<string, unknown>)[k], depth + 1), optional: false };
  }
  return { kind: "object", fields, truncated: keys.length > n };
}

/** Structural merge of two shapes observed for the same slot. */
export function merge(a: Shape, b: Shape): Shape {
  if (a.kind === "unknown") return b;
  if (b.kind === "unknown") return a;
  if (a.kind === "union") return b.kind === "union" ? b.members.reduce(merge, a) : addMember(a, b);
  if (b.kind === "union") return addMember(b, a);
  if (a.kind === "null" && b.kind === "null") return a;
  if (a.kind === "primitive" && b.kind === "primitive") {
    if (a.type === b.type) return a;
    if ((a.type === "integer" && b.type === "number") || (a.type === "number" && b.type === "integer")) {
      return { kind: "primitive", type: "number" };
    }
    return { kind: "union", members: [a, b] };
  }
  if (a.kind === "array" && b.kind === "array") {
    return { kind: "array", element: merge(a.element, b.element), length: Math.max(a.length, b.length) };
  }
  if (a.kind === "object" && b.kind === "object") {
    const fields: Record<string, Field> = {};
    for (const k of Object.keys(a.fields)) {
      const fa = a.fields[k];
      const fb = b.fields[k];
      fields[k] = fb
        ? { shape: merge(fa.shape, fb.shape), optional: fa.optional || fb.optional, source: fa.source ?? fb.source }
        : { ...fa, optional: true };
    }
    for (const k of Object.keys(b.fields)) if (!(k in fields)) fields[k] = { ...b.fields[k], optional: true };
    return { kind: "object", fields, truncated: a.truncated || b.truncated };
  }
  return { kind: "union", members: [a, b] };
}

function addMember(u: Extract<Shape, { kind: "union" }>, s: Shape): Shape {
  const members = [...u.members];
  const at = members.findIndex((m) => sameSlot(m, s));
  if (at >= 0) members[at] = merge(members[at], s);
  else members.push(s);
  return { kind: "union", members };
}

/** Members that should merge rather than sit side by side in a union. */
function sameSlot(a: Shape, b: Shape): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "primitive" && b.kind === "primitive") {
    const num = (t: PrimitiveType) => t === "number" || t === "integer";
    return a.type === b.type || (num(a.type) && num(b.type));
  }
  return true;
}

/** Look up a field on an object-ish shape (unions try each member). */
export function fieldOf(s: Shape, key: string): Field | null {
  if (s.kind === "object") return s.fields[key] ?? null;
  if (s.kind === "union") {
    for (const m of s.members) {
      const f = fieldOf(m, key);
      if (f) return f;
    }
  }
  return null;
}

/** Element shape of an array-ish shape. */
export function elementOf(s: Shape): Shape | null {
  if (s.kind === "array") return s.element;
  if (s.kind === "union") {
    for (const m of s.members) {
      const e = elementOf(m);
      if (e) return e;
    }
  }
  return null;
}

/** The object part of a shape, if any (for listing fields). */
export function objectOf(s: Shape): Extract<Shape, { kind: "object" }> | null {
  if (s.kind === "object") return s;
  if (s.kind === "union") {
    for (const m of s.members) if (m.kind === "object") return m;
  }
  return null;
}

export function isNullable(s: Shape): boolean {
  return s.kind === "null" || (s.kind === "union" && s.members.some((m) => m.kind === "null"));
}

/** Shape of the union of all field values (for `dict.values()` iteration). */
export function valuesOf(s: Shape): Shape {
  const o = objectOf(s);
  if (!o) return UNKNOWN;
  let out: Shape = UNKNOWN;
  for (const k of Object.keys(o.fields)) out = merge(out, o.fields[k].shape);
  return out;
}

// ── rendering ────────────────────────────────────────────────────────────

const IDENT = /^[A-Za-z_$][\w$]*$/;
const PY_IDENT = /^[A-Za-z_][\w]*$/;

export function tsKey(k: string): string {
  return IDENT.test(k) ? k : JSON.stringify(k);
}

export interface RenderOpts {
  /** Break objects onto multiple lines (used for the info panel and type stubs). */
  multiline?: boolean;
  indent?: string;
}

/** TypeScript type text, e.g. `{ id: number; name: string; tags?: string[] }[]`. */
export function tsType(s: Shape, opts: RenderOpts = {}, depth = 0): string {
  const pad = opts.indent ?? "  ";
  switch (s.kind) {
    case "primitive":
      return s.type === "integer" ? "number" : s.type;
    case "null":
      return "null";
    case "unknown":
      return "unknown";
    case "array": {
      const inner = tsType(s.element, opts, depth);
      return s.element.kind === "union" ? `(${inner})[]` : `${inner}[]`;
    }
    case "union":
      return s.members.map((m) => tsType(m, opts, depth)).join(" | ");
    case "object": {
      const keys = Object.keys(s.fields);
      if (keys.length === 0) return "Record<string, unknown>";
      const entries = keys.map((k) => {
        const f = s.fields[k];
        return `${tsKey(k)}${f.optional ? "?" : ""}: ${tsType(f.shape, opts, depth + 1)}`;
      });
      if (s.truncated) entries.push("[key: string]: unknown");
      if (opts.multiline) {
        const inner = pad.repeat(depth + 1);
        return `{\n${entries.map((e) => `${inner}${e};`).join("\n")}\n${pad.repeat(depth)}}`;
      }
      return `{ ${entries.join("; ")} }`;
    }
  }
}

/** Short Python type text: `list[dict]`, `str`, `int | None`. */
export function pyType(s: Shape, depth = 0): string {
  switch (s.kind) {
    case "primitive":
      return s.type === "string" ? "str" : s.type === "integer" ? "int" : s.type === "number" ? "float" : "bool";
    case "null":
      return "None";
    case "unknown":
      return "Any";
    case "array":
      return `list[${pyType(s.element, depth + 1)}]`;
    case "union":
      return s.members.map((m) => pyType(m, depth + 1)).join(" | ");
    case "object": {
      const keys = Object.keys(s.fields);
      if (keys.length === 0) return "dict";
      if (depth > 0) return "dict";
      return `dict{${keys.slice(0, 6).map((k) => `${k}${s.fields[k].optional ? "?" : ""}: ${pyType(s.fields[k].shape, depth + 1)}`).join(", ")}${keys.length > 6 ? ", …" : ""}}`;
    }
  }
}

/** TypedDict-style field listing for the Python info panel. */
export function pyFields(s: Shape): string[] {
  const o = objectOf(s) ?? (s.kind === "array" ? objectOf(s.element) : null);
  if (!o) return [];
  const out = Object.keys(o.fields).map((k) => `${PY_IDENT.test(k) ? k : JSON.stringify(k)}${o.fields[k].optional ? "?" : ""}: ${pyType(o.fields[k].shape, 1)}`);
  if (o.truncated) out.push("…");
  return out;
}

/** One-line description of a shape for the completion `detail` column. */
export function shortType(s: Shape, lang: "python" | "typescript" | "javascript", max = 48): string {
  const text = lang === "python" ? pyType(s) : tsType(s);
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** Compact sample text of a value, bounded in length (arrays show 3 items). */
export function sampleText(value: unknown, max = 160): string {
  const out: string[] = [];
  let len = 0;
  const push = (s: string): boolean => {
    out.push(s);
    len += s.length;
    return len <= max;
  };
  const walk = (v: unknown, depth: number): boolean => {
    if (v === null || v === undefined) return push("null");
    if (typeof v === "string") return push(JSON.stringify(v.length > 40 ? v.slice(0, 40) + "…" : v));
    if (typeof v !== "object") return push(String(v));
    if (depth > 3) return push(Array.isArray(v) ? "[…]" : "{…}");
    if (Array.isArray(v)) {
      if (!push("[")) return false;
      const n = Math.min(v.length, 3);
      for (let i = 0; i < n; i++) {
        if (i > 0 && !push(", ")) return false;
        if (!walk(v[i], depth + 1)) return false;
      }
      if (v.length > n && !push(`, …${v.length - n} more`)) return false;
      return push("]");
    }
    const keys = Object.keys(v as object);
    if (!push("{")) return false;
    const n = Math.min(keys.length, 8);
    for (let i = 0; i < n; i++) {
      if (i > 0 && !push(", ")) return false;
      if (!push(`${keys[i]}: `)) return false;
      if (!walk((v as Record<string, unknown>)[keys[i]], depth + 1)) return false;
    }
    if (keys.length > n && !push(", …")) return false;
    return push("}");
  };
  walk(value, 0);
  const s = out.join("");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
