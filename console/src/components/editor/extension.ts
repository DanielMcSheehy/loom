// CodeMirror glue for data-aware handler editing: a state field holding
// the resolved `TypeContext` (updated via effect, no editor rebuild), a
// completion source for `params` / `inputs` paths and their aliases, a
// hover tooltip showing inferred types, and the "Insert types" command.
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView, hoverTooltip, type Tooltip } from "@codemirror/view";
import type { Tree } from "@lezer/common";
import type { TypeContext } from "./context";
import { resolveContext, type ResolvedContext } from "./resolved";
import {
  type Binding,
  type ChainLang,
  chainText,
  collectBindings,
  completionSite,
  hoverSite,
  type Resolved,
  resolveChain,
  type Trigger,
} from "./resolve";
import { elementOf, isNullable, objectOf, pyFields, pyType, sampleText, type Shape, shortType, tsType } from "./shape";
import { typeStubChanges } from "./typeStubs";

// ── state ────────────────────────────────────────────────────────────────

export const setTypeContext = StateEffect.define<TypeContext | null>();

export const typeContextField = StateField.define<ResolvedContext | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setTypeContext)) return e.value ? resolveContext(e.value) : null;
    return value;
  },
});

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Bindings are cached per syntax tree, so repeated completions in an unchanged doc skip the walk. */
const bindingCache = new WeakMap<Tree, Binding[]>();

function bindingsFor(state: EditorState, lang: ChainLang): Binding[] {
  const tree = syntaxTree(state);
  let b = bindingCache.get(tree);
  if (!b) {
    b = collectBindings(tree, state.doc, lang);
    bindingCache.set(tree, b);
  }
  return b;
}

// ── info / hover panels ──────────────────────────────────────────────────

function el(cls: string, text?: string): HTMLElement {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function typeBlock(shape: Shape, lang: ChainLang): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "cm-loom-type";
  if (lang === "python") {
    const fields = pyFields(shape);
    const head = pyType(shape).replace(/dict\{.*\}$/, shape.kind === "array" ? "list[dict]" : "dict");
    pre.textContent = fields.length ? `${head}  # TypedDict\n${fields.map((f) => "  " + f).join("\n")}` : pyType(shape);
  } else {
    pre.textContent = tsType(shape, { multiline: true });
  }
  return pre;
}

function describeArray(shape: Shape): string | null {
  if (shape.kind === "array") return `${shape.length.toLocaleString()} item${shape.length === 1 ? "" : "s"}`;
  return null;
}

/** The doc panel shown beside a completion and on hover. */
function infoPanel(title: string, r: Resolved, lang: ChainLang): HTMLElement {
  const root = el("cm-loom-info");
  root.appendChild(el("cm-loom-info-title", title));
  root.appendChild(typeBlock(r.shape, lang));
  const meta: string[] = [];
  if (r.source) meta.push(r.source);
  const count = describeArray(r.shape);
  if (count) meta.push(count);
  if (isNullable(r.shape)) meta.push("may be null");
  if (meta.length) root.appendChild(el("cm-loom-info-meta", meta.join(" · ")));
  if (r.hasValue && r.value !== undefined) {
    const s = el("cm-loom-info-sample");
    const label = document.createElement("span");
    label.textContent = "sample ";
    s.appendChild(label);
    s.appendChild(document.createTextNode(sampleText(r.value)));
    root.appendChild(s);
  } else if (r.shape.kind === "unknown") {
    root.appendChild(el("cm-loom-info-meta", "no value yet — run the upstream cell/task to infer its shape"));
  }
  return root;
}

// ── completion ───────────────────────────────────────────────────────────

const ARRAY_METHODS: Array<[string, (e: string) => string]> = [
  ["map", (e) => `(fn: (item: ${e}, i: number) => T) => T[]`],
  ["filter", (e) => `(fn: (item: ${e}) => boolean) => ${e}[]`],
  ["forEach", (e) => `(fn: (item: ${e}) => void) => void`],
  ["find", (e) => `(fn: (item: ${e}) => boolean) => ${e} | undefined`],
  ["some", (e) => `(fn: (item: ${e}) => boolean) => boolean`],
  ["every", (e) => `(fn: (item: ${e}) => boolean) => boolean`],
  ["reduce", (e) => `(fn: (acc: T, item: ${e}) => T, init: T) => T`],
  ["flatMap", (e) => `(fn: (item: ${e}) => U[]) => U[]`],
  ["slice", (e) => `(start?: number, end?: number) => ${e}[]`],
  ["sort", (e) => `(cmp?: (a: ${e}, b: ${e}) => number) => ${e}[]`],
  ["length", () => "number"],
];

/** Site triggers carry line-relative positions; completions need document positions. */
function absoluteTrigger(t: Trigger, lineFrom: number): Trigger {
  return t.kind === "dot" ? { ...t, dotPos: t.dotPos + lineFrom } : { ...t, openPos: t.openPos + lineFrom };
}

/** Build the text a key completion inserts, honouring quotes/closers already present. */
function keyApply(trigger: Trigger, key: string, lang: ChainLang) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const doc = view.state.doc;
    let insert = "";
    let start = from;
    let skip = 0; // chars after `to` to jump over (auto-closed quote/bracket)
    if (trigger.kind === "dot") {
      if (lang === "python" || !IDENT.test(key)) {
        // dict access in Python / non-identifier keys: replace `.` with `["key"]`
        start = trigger.dotPos;
        insert = `${trigger.optional ? "?." : ""}[${JSON.stringify(key)}]`;
      } else {
        insert = key;
      }
    } else {
      const closer = trigger.kind === "bracket" ? "]" : ")";
      const q = trigger.quote ?? '"';
      insert = trigger.quote ? key : `${q}${key}`;
      let at = to;
      if (doc.sliceString(at, at + 1) === q) skip++, at++;
      else insert += q;
      if (doc.sliceString(at, at + 1) === closer) skip++;
      else insert += closer;
    }
    view.dispatch({
      changes: { from: start, to, insert },
      selection: { anchor: start + insert.length + skip },
      userEvent: "input.complete",
    });
  };
}

export function loomCompletionSource(lang: ChainLang) {
  return (context: CompletionContext): CompletionResult | null => {
    const ctx = context.state.field(typeContextField, false);
    if (!ctx) return null;
    const line = context.state.doc.lineAt(context.pos);
    const site = completionSite(line.text, context.pos - line.from);
    if (!site) return null;
    const r = resolveChain(site.chain, context.pos, bindingsFor(context.state, lang), ctx);
    if (!r) return null;
    const from = line.from + site.wordFrom;
    const trigger = absoluteTrigger(site.trigger, line.from);
    const options: Completion[] = [];
    const obj = objectOf(r.shape);
    const elem = elementOf(r.shape);
    const label = chainText(r.chain, lang);

    if (obj && !(trigger.kind === "bracket" && /^\d+$/.test(site.word))) {
      // Keys keep their declaration order (SQL column order, cell order):
      // equal-score options would otherwise sort alphabetically.
      const keys = Object.keys(obj.fields);
      keys.forEach((key, i) => {
        const f = obj.fields[key];
        const child = resolveChain({ root: r.chain.root, segs: [...r.chain.segs, { kind: "key", name: key }] }, context.pos, [], ctx) ?? {
          shape: f.shape,
          source: f.source,
          value: undefined,
          hasValue: false,
          chain: r.chain,
        };
        options.push({
          label: key,
          type: f.shape.kind === "array" ? "variable" : f.shape.kind === "object" ? "namespace" : "property",
          detail: `${f.optional ? "?" : ""}${shortType(f.shape, lang)}`,
          boost: Math.max(0, 99 - i),
          apply: keyApply(trigger, key, lang),
          info: () => infoPanel(chainText(child.chain, lang), child, lang),
        });
      });
    }

    if (elem && trigger.kind !== "get" && (trigger.kind === "dot" || !trigger.quote)) {
      const elemText = shortType(elem, lang, 40);
      const elemR = resolveChain({ root: r.chain.root, segs: [...r.chain.segs, { kind: "index" }] }, context.pos, [], ctx);
      if (trigger.kind === "bracket") {
        options.push({
          label: "0",
          detail: elemText,
          type: "keyword",
          boost: -1,
          apply: (view, _c, f, t) => {
            const next = view.state.doc.sliceString(t, t + 1) === "]";
            view.dispatch({ changes: { from: f, to: t, insert: next ? "0" : "0]" }, selection: { anchor: f + 2 }, userEvent: "input.complete" });
          },
          info: elemR ? () => infoPanel(`${label}[0]`, elemR, lang) : undefined,
        });
      } else if (trigger.kind === "dot") {
        const dot = trigger;
        options.push({
          label: "[0]",
          detail: `first item · ${elemText}`,
          type: "keyword",
          boost: -1,
          apply: (view, _c, _f, t) => {
            view.dispatch({ changes: { from: dot.dotPos, to: t, insert: "[0]" }, selection: { anchor: dot.dotPos + 3 }, userEvent: "input.complete" });
          },
          info: elemR ? () => infoPanel(`${label}[0]`, elemR, lang) : undefined,
        });
        if (lang !== "python") {
          for (const [name, sig] of ARRAY_METHODS) {
            options.push({ label: name, detail: sig(elemText), type: name === "length" ? "property" : "method", boost: -2 });
          }
        }
      }
    }

    if (options.length === 0) return null;
    return { from, options, validFor: /^[\w$-]*$/ };
  };
}

// ── hover ────────────────────────────────────────────────────────────────

export function loomHover(lang: ChainLang) {
  return hoverTooltip(
    (view, pos): Tooltip | null => {
      const ctx = view.state.field(typeContextField, false);
      if (!ctx) return null;
      const line = view.state.doc.lineAt(pos);
      const site = hoverSite(line.text, pos - line.from);
      if (!site) return null;
      const r = resolveChain(site.chain, line.from + site.to, bindingsFor(view.state, lang), ctx);
      if (!r) return null;
      const title = chainText(r.chain, lang);
      const hovered = line.text.slice(site.from, site.to);
      return {
        pos: line.from + site.from,
        end: line.from + site.to,
        above: true,
        create: () => ({ dom: infoPanel(hovered === title || site.chain.segs.length === 0 ? title : `${hovered} → ${title}`, r, lang) }),
      };
    },
    { hoverTime: 250 },
  );
}

// ── insert types ─────────────────────────────────────────────────────────

/** Write/refresh the `Inputs` / `Params` stubs and annotate the handler. */
export function insertTypes(view: EditorView, lang: ChainLang): boolean {
  const ctx = view.state.field(typeContextField, false);
  if (!ctx) return false;
  const changes = typeStubChanges(syntaxTree(view.state), view.state.doc, lang, ctx);
  if (changes.length === 0) return false;
  view.dispatch({ changes, userEvent: "input.types" });
  return true;
}

// ── theme ────────────────────────────────────────────────────────────────

export const loomTypeTheme = EditorView.theme({
  // The info panel is a child of the completion popup positioned outside
  // its box; the popup must not clip it, so rounding/clipping moves to <ul>.
  ".cm-tooltip.cm-tooltip-autocomplete": { overflow: "visible" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { borderRadius: "8px" },
  ".cm-tooltip.cm-completionInfo": {
    padding: "0",
    width: "min(420px, 60vw)",
    maxHeight: "320px",
    overflow: "auto",
  },
  ".cm-tooltip-hover": { padding: "0" },
  ".cm-loom-info": {
    fontFamily: "var(--mono)",
    fontSize: "11.5px",
    lineHeight: "1.5",
    padding: "8px 10px",
    color: "var(--ink-2)",
    maxWidth: "440px",
  },
  ".cm-loom-info-title": {
    color: "var(--ink)",
    fontWeight: "650",
    marginBottom: "4px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  ".cm-loom-type": {
    margin: "0",
    padding: "6px 8px",
    background: "var(--surface-3)",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-sm)",
    color: "var(--s5)",
    whiteSpace: "pre",
    overflow: "auto",
    maxHeight: "180px",
    fontFamily: "inherit",
    fontSize: "inherit",
  },
  ".cm-loom-info-meta": { color: "var(--ink-3)", marginTop: "6px", fontFamily: "var(--sans, inherit)", fontSize: "11px" },
  ".cm-loom-info-sample": {
    color: "var(--ink-3)",
    marginTop: "6px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  ".cm-loom-info-sample > span": { color: "var(--ink-3)", fontFamily: "var(--sans, inherit)", fontSize: "11px" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "2px 8px 2px 4px" },
  ".cm-completionDetail": { color: "var(--ink-3)", fontStyle: "normal", marginLeft: "10px", fontSize: "11px" },
  ".cm-completionLabel": { color: "var(--ink-2)" },
});

/** Everything the editor needs for one language. */
export function loomTypeExtension(lang: ChainLang) {
  // One source instance per editor: the autocompletion plugin tracks active
  // sources by identity, so a fresh closure per call would restart the
  // query on every transaction and the popup would never open.
  const source = loomCompletionSource(lang);
  const data = [{ autocomplete: source }];
  return [typeContextField, EditorState.languageData.of(() => data), loomHover(lang), loomTypeTheme];
}
