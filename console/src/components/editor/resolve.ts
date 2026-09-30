// Resolves "what is the value under the cursor" for handler code.
//
// Two halves:
//  • a small backward lexer over the current line turns the expression
//    just before the cursor into a `Chain` (`inputs["src"][0].name` →
//    root `inputs`, key src, index, key name). It runs on text, not the
//    tree, because the tree is always broken exactly where completion
//    happens (an open quote or a trailing dot).
//  • bindings come from the lezer syntax tree (which is intact above the
//    cursor): `x = inputs["src"]`, `for r in rows`, list comprehensions,
//    `const { src } = inputs`, `for (const r of rows)`, `.map((r) => …)`,
//    `sorted(rows, key=lambda r: …)`, and handler parameter aliases.
// Chains resolve against the context shapes with a bounded recursion so
// aliases of aliases work and cycles stop.
import type { SyntaxNode, Tree } from "@lezer/common";
import { elementOf, fieldOf, type Shape, UNKNOWN, valuesOf } from "./shape";
import type { ResolvedContext } from "./resolved";

export type ChainLang = "python" | "typescript" | "javascript";

export type Seg =
  | { kind: "key"; name: string }
  | { kind: "index" }
  | { kind: "elem" }
  | { kind: "values" };

export interface Chain {
  root: string;
  segs: Seg[];
}

export interface DocLike {
  sliceString(from: number, to: number): string;
  length: number;
}

export function docOf(s: string): DocLike {
  return { sliceString: (a, b) => s.slice(a, b), length: s.length };
}

const ID_CHAR = /[\w$]/;
const ID_START = /[A-Za-z_$]/;

// ── chain lexer (text, backward) ─────────────────────────────────────────

/** Skip whitespace backward; returns the index of the last non-space char + 1. */
function skipWs(t: string, i: number): number {
  while (i > 0 && (t[i - 1] === " " || t[i - 1] === "\t")) i--;
  return i;
}

/** Index of the opening bracket matching the closer at t[close-1], or -1. */
function matchOpen(t: string, close: number, open: string, closer: string): number {
  let depth = 0;
  let i = close;
  while (i > 0) {
    i--;
    const c = t[i];
    if (c === '"' || c === "'" || c === "`") {
      // skip a string literal backward (no escape handling needed for keys)
      let j = i - 1;
      while (j >= 0 && t[j] !== c) j--;
      if (j < 0) return -1;
      i = j;
      continue;
    }
    if (c === closer) depth++;
    else if (c === open) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stringLiteral(s: string): string | null {
  const m = /^\s*(["'])((?:(?!\1).)*)\1\s*$/.exec(s);
  return m ? m[2] : null;
}

/**
 * Parse the member/subscript chain whose last token ends at `end`.
 * Returns null when the text before `end` is not a simple chain.
 */
export function parseChain(t: string, end: number): { chain: Chain; from: number } | null {
  const segs: Seg[] = [];
  let i = skipWs(t, end);
  // Bound the walk so pathological lines stay cheap.
  for (let guard = 0; guard < 64; guard++) {
    if (i <= 0) return null;
    const c = t[i - 1];
    if (c === "]") {
      const open = matchOpen(t, i, "[", "]");
      if (open < 0) return null;
      const inner = t.slice(open + 1, i - 1);
      const key = stringLiteral(inner);
      segs.push(key !== null ? { kind: "key", name: key } : { kind: "index" });
      i = skipWs(t, open);
      continue;
    }
    if (c === ")") {
      const open = matchOpen(t, i, "(", ")");
      if (open < 0) return null;
      const inner = t.slice(open + 1, i - 1);
      const before = skipWs(t, open);
      const callee = /(\??\.)([A-Za-z_$][\w$]*)$/.exec(t.slice(Math.max(0, before - 40), before));
      if (!callee) return null;
      const method = callee[2];
      const calleeStart = before - callee[0].length;
      if (method === "get") {
        const first = inner.split(",")[0];
        const key = stringLiteral(first);
        if (key === null) return null;
        segs.push({ kind: "key", name: key });
      } else if (method === "values") {
        segs.push({ kind: "values" });
      } else if (SAME_SHAPE_METHODS.has(method)) {
        // filter/slice/sort… keep the receiver's shape
      } else {
        return null;
      }
      i = skipWs(t, calleeStart);
      continue;
    }
    if (ID_CHAR.test(c)) {
      let s = i;
      while (s > 0 && ID_CHAR.test(t[s - 1])) s--;
      const name = t.slice(s, i);
      if (!ID_START.test(name[0])) return null;
      const before = skipWs(t, s);
      const prev = t.slice(Math.max(0, before - 2), before);
      if (prev.endsWith("?.")) {
        segs.push({ kind: "key", name });
        i = skipWs(t, before - 2);
        continue;
      }
      if (prev.endsWith(".")) {
        segs.push({ kind: "key", name });
        i = skipWs(t, before - 1);
        continue;
      }
      // Root identifier. Refuse if preceded by something that makes this a
      // member of a larger expression we can't see (e.g. `foo(x).bar`).
      const pc = before > 0 ? t[before - 1] : "";
      if (pc === "." || pc === ")" || pc === "]") return null;
      segs.reverse();
      return { chain: { root: name, segs }, from: s };
    }
    return null;
  }
  return null;
}

/** Array-returning methods whose result has the receiver's shape. */
export const SAME_SHAPE_METHODS = new Set(["filter", "slice", "sort", "reverse", "concat", "toSorted", "toReversed", "copy"]);

export type Trigger =
  | { kind: "dot"; optional: boolean; dotPos: number }
  | { kind: "bracket"; quote: string | null; openPos: number }
  | { kind: "get"; quote: string | null; openPos: number };

export interface Site {
  chain: Chain;
  trigger: Trigger;
  /** Start of the partial word being typed (after any opening quote). */
  wordFrom: number;
  word: string;
}

/**
 * Inspect the text before the cursor for a completion site: a chain
 * followed by `.`, `?.`, `[`, `["`, `.get(` or `.get("` and a partial word.
 * Positions are relative to `t`.
 */
export function completionSite(t: string, pos: number): Site | null {
  // partial word: identifier chars, plus `-` inside quotes (cell/task names)
  let ws = pos;
  while (ws > 0 && (ID_CHAR.test(t[ws - 1]) || t[ws - 1] === "-")) ws--;
  let quote: string | null = null;
  let k = ws;
  if (k > 0 && (t[k - 1] === '"' || t[k - 1] === "'")) {
    quote = t[k - 1];
    k--;
  } else {
    // no quote: `-` is an operator, keep only the identifier tail
    ws = pos;
    while (ws > 0 && ID_CHAR.test(t[ws - 1])) ws--;
    k = ws;
  }
  const word = t.slice(ws, pos);
  const b = skipWs(t, k);
  if (b <= 0) return null;
  const c = t[b - 1];
  let trigger: Trigger;
  let chainEnd: number;
  if (c === "[") {
    trigger = { kind: "bracket", quote, openPos: b - 1 };
    chainEnd = b - 1;
  } else if (c === "(") {
    const before = skipWs(t, b - 1);
    if (!/\??\.get$/.test(t.slice(Math.max(0, before - 6), before))) return null;
    trigger = { kind: "get", quote, openPos: b - 1 };
    chainEnd = before - (t[before - 5] === "?" ? 5 : 4);
  } else if (c === "." && quote === null) {
    const optional = b >= 2 && t[b - 2] === "?";
    trigger = { kind: "dot", optional, dotPos: optional ? b - 2 : b - 1 };
    chainEnd = optional ? b - 2 : b - 1;
  } else {
    return null;
  }
  const parsed = parseChain(t, chainEnd);
  if (!parsed) return null;
  return { chain: parsed.chain, trigger, wordFrom: ws, word };
}

/**
 * For hover: the chain ending with the word around `pos` (identifier or a
 * quoted key inside `[...]` / `.get(...)`). Returns the chain plus the
 * word's span.
 */
export function hoverSite(t: string, pos: number): { chain: Chain; from: number; to: number } | null {
  let from = pos;
  let to = pos;
  while (from > 0 && (ID_CHAR.test(t[from - 1]) || t[from - 1] === "-")) from--;
  while (to < t.length && (ID_CHAR.test(t[to]) || t[to] === "-")) to++;
  if (from === to) return null;
  const word = t.slice(from, to);
  const q = from > 0 ? t[from - 1] : "";
  if ((q === '"' || q === "'") && t[to] === q) {
    // quoted key: `["src"]` or `.get("src"`
    const b = skipWs(t, from - 1);
    const c = t[b - 1];
    let chainEnd = -1;
    if (c === "[") chainEnd = b - 1;
    else if (c === "(") {
      const before = skipWs(t, b - 1);
      if (/\.get$/.test(t.slice(Math.max(0, before - 4), before))) chainEnd = before - 4;
    }
    if (chainEnd < 0) return null;
    const parsed = parseChain(t, chainEnd);
    if (!parsed) return null;
    return { chain: { root: parsed.chain.root, segs: [...parsed.chain.segs, { kind: "key", name: word }] }, from, to };
  }
  if (word.includes("-") || !ID_START.test(word[0])) return null;
  const parsed = parseChain(t, to);
  return parsed ? { chain: parsed.chain, from, to } : null;
}

// ── bindings (syntax tree) ───────────────────────────────────────────────

export interface Binding {
  name: string;
  chain: Chain;
  /** Scope in which the binding is visible. */
  from: number;
  to: number;
  /** Position at which to resolve the bound expression (its end). */
  at: number;
}

const ELEM_FIRST = new Set(["map", "filter", "forEach", "find", "findIndex", "findLast", "findLastIndex", "some", "every", "flatMap"]);
const ELEM_SECOND = new Set(["reduce", "reduceRight"]);
const PY_KEY_FUNCS = new Set(["sorted", "max", "min", "sum", "any", "all", "list", "next"]);

function text(doc: DocLike, n: SyntaxNode): string {
  return doc.sliceString(n.from, n.to);
}

function unquote(s: string): string | null {
  const m = /^(?:[rRbBuUfF]*)(["'])([\s\S]*)\1$/.exec(s);
  return m ? m[2] : null;
}

/** Chain for an expression node, or null when it is not a member chain. */
export function nodeChain(doc: DocLike, node: SyntaxNode | null, lang: ChainLang): Chain | null {
  if (!node) return null;
  if (node.name === "ParenthesizedExpression") return nodeChain(doc, node.firstChild?.nextSibling ?? null, lang);
  if (node.name === "VariableName") return { root: text(doc, node), segs: [] };
  if (node.name === "MemberExpression") {
    const obj = node.firstChild;
    const base = nodeChain(doc, obj, lang);
    if (!base || !obj) return null;
    let cur = obj.nextSibling;
    while (cur && (cur.name === "." || cur.name === "?." || cur.name === "[")) {
      const open = cur.name === "[";
      cur = cur.nextSibling;
      if (!cur) return null;
      if (open) {
        if (cur.name === "String") {
          const key = unquote(text(doc, cur));
          if (key === null) return null;
          base.segs.push({ kind: "key", name: key });
        } else {
          base.segs.push({ kind: "index" });
        }
        // skip to the closing bracket
        while (cur && cur.name !== "]") cur = cur.nextSibling;
        if (cur) cur = cur.nextSibling;
      } else if (cur.name === "PropertyName") {
        base.segs.push({ kind: "key", name: text(doc, cur) });
        cur = cur.nextSibling;
      } else {
        return null;
      }
    }
    return base;
  }
  if (node.name === "CallExpression") {
    const callee = node.firstChild;
    const args = node.getChild("ArgList");
    if (!callee) return null;
    if (callee.name === "MemberExpression") {
      const prop = callee.getChild("PropertyName");
      const recv = nodeChain(doc, callee.firstChild, lang);
      if (!prop || !recv) return null;
      const method = text(doc, prop);
      if (method === "get" && lang === "python") {
        const first = args?.firstChild?.nextSibling;
        const key = first && first.name === "String" ? unquote(text(doc, first)) : null;
        if (key === null) return null;
        recv.segs.push({ kind: "key", name: key });
        return recv;
      }
      if (method === "values") {
        recv.segs.push({ kind: "values" });
        return recv;
      }
      if (SAME_SHAPE_METHODS.has(method)) return recv;
      return null;
    }
    if (callee.name === "VariableName" && lang === "python") {
      const fn = text(doc, callee);
      if (fn === "sorted" || fn === "list" || fn === "reversed") {
        const first = args?.firstChild?.nextSibling;
        return nodeChain(doc, first ?? null, lang);
      }
    }
    return null;
  }
  return null;
}

function elem(chain: Chain): Chain {
  return { root: chain.root, segs: [...chain.segs, { kind: "elem" }] };
}

function withKey(chain: Chain, key: string): Chain {
  return { root: chain.root, segs: [...chain.segs, { kind: "key", name: key }] };
}

/** Names bound by a JS pattern (identifier, `{a, b: c}`, `[x]`) → chains. */
function jsPattern(doc: DocLike, node: SyntaxNode, chain: Chain, out: Array<{ name: string; chain: Chain }>) {
  if (node.name === "VariableDefinition") {
    out.push({ name: text(doc, node), chain });
    return;
  }
  if (node.name === "ObjectPattern") {
    for (let p = node.firstChild; p; p = p.nextSibling) {
      if (p.name !== "PatternProperty") continue;
      const key = p.getChild("PropertyName");
      if (!key) continue;
      const target = p.getChild("VariableDefinition") ?? p.getChild("ObjectPattern") ?? p.getChild("ArrayPattern");
      const k = text(doc, key);
      if (!target) out.push({ name: k, chain: withKey(chain, k) });
      else jsPattern(doc, target, withKey(chain, k), out);
    }
    return;
  }
  if (node.name === "ArrayPattern") {
    for (let p = node.firstChild; p; p = p.nextSibling) {
      if (p.name === "VariableDefinition" || p.name === "ObjectPattern" || p.name === "ArrayPattern") jsPattern(doc, p, elem(chain), out);
    }
  }
}

function paramNodes(list: SyntaxNode | null, lang: ChainLang): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  if (!list) return out;
  const want = lang === "python" ? "VariableName" : "VariableDefinition";
  for (let p = list.firstChild; p; p = p.nextSibling) {
    if (p.name === want || p.name === "ObjectPattern" || p.name === "ArrayPattern") out.push(p);
  }
  return out;
}

/** Collect every binding the resolver understands, in one tree walk. */
export function collectBindings(tree: Tree, doc: DocLike, lang: ChainLang): Binding[] {
  const out: Binding[] = [];
  const add = (name: string, chain: Chain, from: number, to: number, at: number) => {
    if (name) out.push({ name, chain, from, to, at });
  };
  const cursor = tree.cursor();
  do {
    const node = cursor.node;
    const n = node.name;
    if (lang === "python") {
      if (n === "AssignStatement") {
        const target = node.firstChild;
        const op = node.getChild("AssignOp");
        const expr = op?.nextSibling;
        if (target?.name === "VariableName" && op && expr && target.nextSibling && (target.nextSibling.name === "AssignOp" || target.nextSibling.name === "TypeDef")) {
          const chain = nodeChain(doc, expr, lang);
          if (chain) add(text(doc, target), chain, node.to, node.parent?.to ?? doc.length, expr.to);
        }
      } else if (n === "ForStatement" || n.endsWith("ComprehensionExpression")) {
        // for a, b in expr  |  [x for a in expr]
        let cur: SyntaxNode | null = node.firstChild;
        while (cur) {
          if (cur.name === "for") {
            const names: SyntaxNode[] = [];
            let p = cur.nextSibling;
            while (p && p.name !== "in") {
              if (p.name === "VariableName") names.push(p);
              p = p.nextSibling;
            }
            const expr = p?.nextSibling ?? null;
            const chain = nodeChain(doc, expr, lang);
            const scopeFrom = n === "ForStatement" ? (expr?.to ?? node.from) : node.from;
            if (chain && expr) {
              if (names.length === 1) add(text(doc, names[0]), elem(chain), scopeFrom, node.to, expr.to);
              else if (names.length === 2 && chain.segs.at(-1)?.kind === "values") {
                // `for k, v in d.items()` is parsed as `.items()` (unknown); we
                // only bind the value when the iterable is `.values()`.
              }
            } else if (expr && names.length === 2 && expr.name === "CallExpression") {
              // for k, v in d.items()
              const callee = expr.firstChild;
              const prop = callee?.name === "MemberExpression" ? callee.getChild("PropertyName") : null;
              const recv = callee?.name === "MemberExpression" ? nodeChain(doc, callee.firstChild, lang) : null;
              if (prop && recv && text(doc, prop) === "items") {
                add(text(doc, names[1]), elem({ root: recv.root, segs: [...recv.segs, { kind: "values" }] }), scopeFrom, node.to, expr.to);
              }
            }
          }
          cur = cur.nextSibling;
        }
      } else if (n === "LambdaExpression") {
        const params = paramNodes(node.getChild("ParamList"), lang);
        const argList = node.parent;
        const call = argList?.name === "ArgList" ? argList.parent : null;
        if (params.length && call?.name === "CallExpression" && argList) {
          const callee = call.firstChild;
          let iterable: SyntaxNode | null = null;
          if (callee?.name === "VariableName") {
            const fn = text(doc, callee);
            const args: SyntaxNode[] = [];
            for (let a = argList.firstChild; a; a = a.nextSibling) {
              if (a.name !== "(" && a.name !== ")" && a.name !== "," && a.name !== "AssignOp" && a.name !== "VariableName") args.push(a);
              else if (a.name === "VariableName" && a.nextSibling?.name !== "AssignOp") args.push(a);
            }
            if (fn === "map" || fn === "filter") iterable = args[1] ?? null;
            else if (PY_KEY_FUNCS.has(fn)) iterable = args[0] ?? null;
          } else if (callee?.name === "MemberExpression") {
            const prop = callee.getChild("PropertyName");
            if (prop && text(doc, prop) === "sort") iterable = callee.firstChild;
          }
          const chain = nodeChain(doc, iterable, lang);
          if (chain && iterable) add(text(doc, params[0]), elem(chain), node.from, node.to, iterable.to);
        }
      } else if (n === "FunctionDefinition") {
        const name = node.getChild("VariableName");
        if (name && text(doc, name) === "handler") {
          const params = paramNodes(node.getChild("ParamList"), lang);
          const roots = ["params", "inputs"];
          params.slice(0, 2).forEach((p, i) => {
            const pn = text(doc, p);
            if (pn !== roots[i]) add(pn, { root: roots[i], segs: [] }, node.from, node.to, node.from);
          });
        }
      }
    } else {
      if (n === "VariableDeclaration") {
        let target: SyntaxNode | null = null;
        for (let c = node.firstChild; c; c = c.nextSibling) {
          if (c.name === "VariableDefinition" || c.name === "ObjectPattern" || c.name === "ArrayPattern") target = c;
          else if (c.name === "Equals" && target) {
            const expr = c.nextSibling;
            const chain = nodeChain(doc, expr, lang);
            if (chain && expr) {
              const found: Array<{ name: string; chain: Chain }> = [];
              jsPattern(doc, target, chain, found);
              for (const f of found) add(f.name, f.chain, node.to, node.parent?.to ?? doc.length, expr.to);
            } else if (expr && target.name === "VariableDefinition" && (expr.name === "ArrowFunction" || expr.name === "FunctionExpression") && text(doc, target) === "handler") {
              handlerAliases(doc, expr.getChild("ParamList"), expr, lang, add);
            }
            target = null;
          }
        }
      } else if (n === "ForOfSpec") {
        let target: SyntaxNode | null = null;
        for (let c = node.firstChild; c; c = c.nextSibling) {
          if (c.name === "VariableDefinition" || c.name === "ObjectPattern" || c.name === "ArrayPattern") target = c;
          else if (c.name === "of" && target) {
            const expr = c.nextSibling;
            const chain = nodeChain(doc, expr, lang);
            if (chain && expr) {
              const found: Array<{ name: string; chain: Chain }> = [];
              jsPattern(doc, target, elem(chain), found);
              const scope = node.parent ?? node;
              for (const f of found) add(f.name, f.chain, node.to, scope.to, expr.to);
            }
          }
        }
      } else if (n === "ArrowFunction" || n === "FunctionExpression") {
        const params = paramNodes(node.getChild("ParamList"), lang);
        const argList = node.parent;
        const call = argList?.name === "ArgList" ? argList.parent : null;
        if (params.length && call?.name === "CallExpression") {
          const callee = call.firstChild;
          if (callee?.name === "MemberExpression") {
            const prop = callee.getChild("PropertyName");
            const recv = nodeChain(doc, callee.firstChild, lang);
            const method = prop ? text(doc, prop) : "";
            if (prop && recv) {
              const bindElem = (p: SyntaxNode) => {
                const found: Array<{ name: string; chain: Chain }> = [];
                jsPattern(doc, p, elem(recv), found);
                for (const f of found) add(f.name, f.chain, node.from, node.to, callee.firstChild!.to);
              };
              if (ELEM_FIRST.has(method)) bindElem(params[0]);
              else if (ELEM_SECOND.has(method) && params[1]) bindElem(params[1]);
              else if (method === "sort" || method === "toSorted") params.slice(0, 2).forEach(bindElem);
            }
          }
        }
      } else if (n === "FunctionDeclaration") {
        const name = node.getChild("VariableDefinition");
        if (name && text(doc, name) === "handler") handlerAliases(doc, node.getChild("ParamList"), node, lang, add);
      }
    }
  } while (cursor.next());
  return out;
}

function handlerAliases(
  doc: DocLike,
  list: SyntaxNode | null,
  scope: SyntaxNode,
  lang: ChainLang,
  add: (name: string, chain: Chain, from: number, to: number, at: number) => void,
) {
  const params = paramNodes(list, lang);
  const roots = ["params", "inputs"];
  params.slice(0, 2).forEach((p, i) => {
    const found: Array<{ name: string; chain: Chain }> = [];
    jsPattern(doc, p, { root: roots[i], segs: [] }, found);
    for (const f of found) if (!(f.name === roots[i] && f.chain.segs.length === 0)) add(f.name, f.chain, scope.from, scope.to, scope.from);
  });
}

// ── resolution ───────────────────────────────────────────────────────────

export interface Resolved {
  shape: Shape;
  /** Which input the value descends from (its `source`), if any. */
  source?: string;
  /** Root-relative sample value, when the path could be walked on real data. */
  value: unknown;
  hasValue: boolean;
  /** Normalized chain (aliases expanded). */
  chain: Chain;
}

function step(s: Shape, seg: Seg): Shape {
  if (s.kind === "unknown") return UNKNOWN;
  switch (seg.kind) {
    case "key":
      return fieldOf(s, seg.name)?.shape ?? UNKNOWN;
    case "index":
    case "elem":
      return elementOf(s) ?? UNKNOWN;
    case "values":
      return { kind: "array", element: valuesOf(s), length: 0 };
  }
}

function stepValue(v: unknown, seg: Seg): { value: unknown; ok: boolean } {
  if (v === null || typeof v !== "object") return { value: undefined, ok: false };
  switch (seg.kind) {
    case "key":
      return Array.isArray(v) ? { value: undefined, ok: false } : { value: (v as Record<string, unknown>)[seg.name], ok: seg.name in (v as object) };
    case "index":
    case "elem":
      return Array.isArray(v) ? { value: v[0], ok: v.length > 0 } : { value: undefined, ok: false };
    case "values":
      return Array.isArray(v) ? { value: undefined, ok: false } : { value: Object.values(v as object), ok: true };
  }
}

/**
 * Resolve a chain at `pos` against the context, following bindings visible
 * at that position. Returns null when the root is not (transitively)
 * `params` or `inputs`.
 */
export function resolveChain(chain: Chain, pos: number, bindings: Binding[], ctx: ResolvedContext, depth = 0): Resolved | null {
  if (depth > 12) return null;
  let base: Resolved;
  if (chain.root === "inputs" || chain.root === "params") {
    const root = chain.root;
    base = {
      shape: ctx[root],
      source: root === "params" ? ctx.paramsSource : ctx.inputsSource,
      value: ctx.values[root],
      hasValue: root === "params" ? ctx.values.params !== undefined : true,
      chain: { root, segs: [] },
    };
  } else {
    let best: Binding | null = null;
    for (const b of bindings) {
      if (b.name !== chain.root || pos < b.from || pos > b.to) continue;
      if (!best || b.from >= best.from) best = b;
    }
    if (!best) return null;
    const r = resolveChain(best.chain, best.at, bindings, ctx, depth + 1);
    if (!r) return null;
    base = r;
  }
  let { shape, value, hasValue } = base;
  let source = base.source;
  const segs = [...base.chain.segs];
  for (const seg of chain.segs) {
    if (seg.kind === "key" && base.chain.root === "inputs" && segs.length === 0) {
      source = fieldOf(ctx.inputs, seg.name)?.source ?? source;
    }
    shape = step(shape, seg);
    if (hasValue) {
      const r = stepValue(value, seg);
      value = r.value;
      hasValue = r.ok;
    }
    segs.push(seg);
  }
  return { shape, source, value, hasValue, chain: { root: base.chain.root, segs } };
}

/** Human-readable chain text, e.g. `inputs.src[0].name`. */
export function chainText(chain: Chain, lang: ChainLang): string {
  let s = chain.root;
  for (const seg of chain.segs) {
    if (seg.kind === "key") s += /^[A-Za-z_$][\w$]*$/.test(seg.name) && lang !== "python" ? `.${seg.name}` : `[${JSON.stringify(seg.name)}]`;
    else if (seg.kind === "values") s += ".values()";
    else s += "[0]";
  }
  return s;
}
