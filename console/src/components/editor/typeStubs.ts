// "Insert types": turn the resolved context into static type stubs and a
// handler-signature annotation. Explicit user action only — nothing here
// runs on its own. Stubs live between marker comments so re-running the
// action replaces the block instead of stacking copies.
import type { SyntaxNode, Tree } from "@lezer/common";
import type { ResolvedContext } from "./resolved";
import type { ChainLang, DocLike } from "./resolve";
import { pyType, type Shape, tsType } from "./shape";

export const STUB_START = "loom:types";
export const STUB_END = "loom:types end";

export interface Change {
  from: number;
  to: number;
  insert: string;
}

// ── TypeScript / JavaScript ──────────────────────────────────────────────

function tsBlock(ctx: ResolvedContext, jsdoc: boolean): string {
  const inputs = tsType(ctx.inputs, { multiline: true });
  const params = tsType(ctx.params, { multiline: true });
  if (jsdoc) {
    // JSDoc typedefs; TypeScript-flavoured object types are accepted by
    // editors that understand `checkJs`.
    const one = (s: string) => s.replace(/\n\s*/g, " ");
    return [
      `/** ${STUB_START} — inferred from the current inputs/params; use “Insert types” again to refresh.`,
      ` * @typedef {${one(inputs)}} Inputs`,
      ` * @typedef {${one(params)}} Params`,
      ` * ${STUB_END} */`,
      "",
    ].join("\n");
  }
  return [
    `// ${STUB_START} — inferred from the current inputs/params; use “Insert types” again to refresh.`,
    `type Inputs = ${inputs};`,
    `type Params = ${params};`,
    `// ${STUB_END}`,
    "",
  ].join("\n");
}

/** Annotation text we are allowed to replace (inline/structural, not a user-named type). */
const TS_SAFE_TYPE_WORDS = new Set(["Record", "string", "number", "boolean", "unknown", "any", "null", "undefined", "object", "Params", "Inputs", "Array", "never", "Partial", "readonly"]);

function replaceableTs(annotation: string): boolean {
  const words = annotation.match(/[A-Za-z_$][\w$]*/g) ?? [];
  return words.every((w) => TS_SAFE_TYPE_WORDS.has(w));
}

function findHandlerParams(tree: Tree, doc: DocLike, lang: ChainLang): SyntaxNode[] | null {
  const want = lang === "python" ? "FunctionDefinition" : "FunctionDeclaration";
  const nameNode = lang === "python" ? "VariableName" : "VariableDefinition";
  let list: SyntaxNode | null = null;
  const cursor = tree.cursor();
  do {
    const n = cursor.node;
    if (n.name === want) {
      const name = n.getChild(nameNode);
      if (name && doc.sliceString(name.from, name.to) === "handler") {
        list = n.getChild("ParamList");
        break;
      }
    } else if (lang !== "python" && n.name === "VariableDeclaration") {
      const def = n.getChild("VariableDefinition");
      if (def && doc.sliceString(def.from, def.to) === "handler") {
        const fn = n.getChild("ArrowFunction") ?? n.getChild("FunctionExpression");
        if (fn) {
          list = fn.getChild("ParamList");
          break;
        }
      }
    }
  } while (cursor.next());
  if (!list) return null;
  const out: SyntaxNode[] = [];
  for (let p = list.firstChild; p; p = p.nextSibling) {
    if (p.name === (lang === "python" ? "VariableName" : "VariableDefinition")) out.push(p);
  }
  return out;
}

/** Existing stub block span, or null. */
export function stubSpan(text: string): { from: number; to: number } | null {
  const start = text.indexOf(STUB_START);
  if (start < 0) return null;
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const endIdx = text.indexOf(STUB_END, start + STUB_START.length);
  if (endIdx < 0) return null;
  let end = text.indexOf("\n", endIdx);
  end = end < 0 ? text.length : end + 1;
  return { from: lineStart, to: end };
}

/**
 * Compute the document changes for "Insert types": replace/insert the stub
 * block and annotate the first two handler parameters. Positions refer to
 * the document `tree` was parsed from.
 */
export function typeStubChanges(tree: Tree, doc: DocLike, lang: ChainLang, ctx: ResolvedContext): Change[] {
  const text = doc.sliceString(0, doc.length);
  const changes: Change[] = [];
  const block = lang === "python" ? pyBlock(ctx) : tsBlock(ctx, lang === "javascript");
  const span = stubSpan(text);
  if (span) changes.push({ from: span.from, to: span.to, insert: block });
  else changes.push({ from: 0, to: 0, insert: block + (text.startsWith("\n") ? "" : "\n") });

  const params = findHandlerParams(tree, doc, lang);
  if (!params) return changes;
  const names = ["Params", "Inputs"];
  params.slice(0, 2).forEach((p, i) => {
    const ann = p.nextSibling;
    if (lang === "python") {
      if (ann?.name === "TypeDef") {
        const cur = doc.sliceString(ann.from + 1, ann.to).trim();
        if (/^(dict|Any|dict\[str,\s*Any\]|Params|Inputs)$/.test(cur)) changes.push({ from: ann.from, to: ann.to, insert: `: ${names[i]}` });
      } else {
        changes.push({ from: p.to, to: p.to, insert: `: ${names[i]}` });
      }
      return;
    }
    if (lang === "javascript") return; // JSDoc handles JS below
    if (ann?.name === "TypeAnnotation") {
      const cur = doc.sliceString(ann.from + 1, ann.to).trim();
      if (replaceableTs(cur)) changes.push({ from: ann.from, to: ann.to, insert: `: ${names[i]}` });
    } else {
      changes.push({ from: p.to, to: p.to, insert: `: ${names[i]}` });
    }
  });

  if (lang === "javascript") {
    // Put a @param JSDoc right above the handler unless one is already there.
    const list = params[0]?.parent;
    const fn = list?.parent;
    const decl = fn?.parent?.name === "ExportDeclaration" ? fn.parent : fn?.parent?.name === "VariableDeclaration" ? (fn.parent.parent?.name === "ExportDeclaration" ? fn.parent.parent : fn.parent) : fn;
    if (decl) {
      const lineStart = text.lastIndexOf("\n", decl.from - 1) + 1;
      const before = text.slice(0, lineStart).trimEnd();
      if (!before.endsWith("*/") || !/@param\s*\{(Params|Inputs)\}/.test(before.slice(-200))) {
        const indent = text.slice(lineStart, decl.from);
        changes.push({ from: lineStart, to: lineStart, insert: `${indent}/** @param {Params} params @param {Inputs} inputs */\n` });
      }
    }
  }
  return changes.sort((a, b) => a.from - b.from);
}

// ── Python ───────────────────────────────────────────────────────────────

function pascal(s: string): string {
  const p = s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^\d+/, "");
  return p ? p[0].toUpperCase() + p.slice(1) : "Field";
}

const PY_IDENT = /^[A-Za-z_]\w*$/;

/**
 * TypedDict stubs: one class per distinct object shape, named by path
 * (`InputsSrcItem`, `InputsStats`), then `Inputs` and `Params`.
 */
function pyBlock(ctx: ResolvedContext): string {
  const classes: string[] = [];
  const used = new Set<string>();
  const uniq = (base: string) => {
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base}${n++}`;
    used.add(name);
    return name;
  };

  // Returns the type expression for `s`, emitting TypedDict classes for
  // any object shapes along the way.
  const render = (s: Shape, path: string): string => {
    switch (s.kind) {
      case "array":
        return `list[${render(s.element, path + "Item")}]`;
      case "union":
        return s.members.map((m) => render(m, path)).join(" | ");
      case "object": {
        const keys = Object.keys(s.fields);
        if (keys.length === 0) return "dict[str, Any]";
        const fields = keys.filter((k) => PY_IDENT.test(k)).map((k) => `    ${k}: ${render(s.fields[k].shape, path + pascal(k))}`);
        const skipped = keys.filter((k) => !PY_IDENT.test(k));
        if (fields.length === 0) return "dict[str, Any]";
        const name = uniq(path);
        const total = keys.some((k) => s.fields[k].optional) ? ", total=False" : "";
        const notes = [
          ...(total ? ["    # total=False: some keys were missing in part of the sample"] : []),
          ...(skipped.length ? [`    # keys not valid as identifiers: ${skipped.map((k) => JSON.stringify(k)).join(", ")}`] : []),
          ...(s.truncated ? ["    # (more keys omitted)"] : []),
        ];
        classes.push(`class ${name}(TypedDict${total}):\n${[...notes, ...fields].join("\n")}`);
        return name;
      }
      default:
        return pyType(s);
    }
  };

  const inputsType = render(ctx.inputs, "Inputs");
  const paramsType = render(ctx.params, "Params");
  const alias = (name: string, t: string) => (t === name ? [] : [`${name} = ${t}`]);
  return [
    `# ${STUB_START} — inferred from the current inputs/params; use “Insert types” again to refresh.`,
    "from typing import Any, TypedDict",
    "",
    ...classes.flatMap((c) => [c, ""]),
    ...alias("Inputs", inputsType),
    ...alias("Params", paramsType),
    `# ${STUB_END}`,
    "",
  ].join("\n");
}
