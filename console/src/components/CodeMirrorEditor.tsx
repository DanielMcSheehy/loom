// Code editing and display.
//
// Editors are CodeMirror 6 instances — autocomplete, bracket matching &
// auto-close, multi-cursor (Alt-click / Cmd-D style selection), undo
// history, search, code folding — wrapped in a controlled React component
// and themed to the console palette. Read-only blocks stay on Prism (a
// full editor instance per displayed snippet would be waste).
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension, Prec } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import type { CodeLanguage } from "./CodeBlock";

// ── theme (matches the console palette) ──────────────────────────────────

const loomTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "transparent",
      color: "var(--ink-2)",
      fontSize: "12.5px",
      borderRadius: "var(--radius-sm)",
      width: "100%",
      minWidth: "0",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "var(--mono)",
      lineHeight: "1.6",
      maxHeight: "520px",
    },
    ".cm-content": { caretColor: "var(--ink)", padding: "8px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
      { background: "var(--accent-ring)" },
    ".cm-selectionMatch": { background: "var(--accent-soft)" },
    ".cm-activeLine": { background: "var(--surface-2)" },
    ".cm-activeLineGutter": { background: "transparent", color: "var(--ink-2)" },
    ".cm-gutters": {
      background: "transparent",
      color: "var(--ink-3)",
      border: "none",
      paddingLeft: "4px",
    },
    ".cm-foldGutter .cm-gutterElement": { color: "var(--ink-3)" },
    ".cm-matchingBracket": {
      background: "var(--accent-soft)",
      outline: "1px solid var(--accent-ring)",
    },
    ".cm-nonmatchingBracket": { background: "var(--critical-soft)" },
    ".cm-tooltip": {
      background: "var(--surface-2)",
      border: "1px solid var(--border-strong)",
      borderRadius: "8px",
      color: "var(--ink-2)",
      boxShadow: "var(--shadow-lg)",
      overflow: "hidden",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
      fontFamily: "var(--mono)",
      fontSize: "12px",
      maxHeight: "220px",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      background: "var(--accent-soft)",
      color: "var(--ink)",
    },
    ".cm-completionIcon": { color: "var(--ink-3)" },
    ".cm-completionMatchedText": {
      textDecoration: "none",
      color: "var(--accent)",
      fontWeight: "650",
    },
    ".cm-panels": {
      background: "var(--surface-2)",
      color: "var(--ink-2)",
      borderTop: "1px solid var(--border)",
    },
    ".cm-searchMatch": { background: "var(--warning-soft)" },
    ".cm-searchMatch-selected": { background: "var(--warning)" },
  },
  {},
);

const loomHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword], color: "var(--s7)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--s3)" },
  { tag: [t.number, t.bool, t.atom, t.null], color: "var(--s2)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--s1)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)], color: "var(--s5)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--ink-2)" },
  { tag: [t.comment, t.docComment], color: "var(--ink-3)", fontStyle: "italic" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--ink-3)" },
  { tag: [t.meta, t.annotation], color: "var(--s4)" },
  { tag: t.variableName, color: "var(--ink-2)" },
  { tag: t.heading, color: "var(--ink)", fontWeight: "650" },
  { tag: t.strong, fontWeight: "650", color: "var(--ink)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.link, t.url], color: "var(--accent)", textDecoration: "underline" },
]);

function languageExtension(language: CodeLanguage): Extension {
  switch (language) {
    case "python":
      return python();
    case "typescript":
      return javascript({ typescript: true });
    case "javascript":
      return javascript();
    case "sql":
      return sql({ upperCaseKeywords: true });
    case "json":
      return json();
    case "markdown":
      return markdown();
    case "plain":
      return [];
  }
}

// ── editable editor ──────────────────────────────────────────────────────

export default function CodeEditor({
  value,
  onChange,
  language,
  minRows = 3,
  onRun,
  onShiftRun,
  onEscape,
  onFocus,
  onBlur,
  autoFocus,
  lineNumbers: showLineNumbers = true,
}: {
  value: string;
  onChange: (next: string) => void;
  language: CodeLanguage;
  minRows?: number;
  /** Invoked on Mod-Enter (run the cell / query). */
  onRun?: () => void;
  /** Invoked on Shift-Enter (run and advance). */
  onShiftRun?: () => void;
  onEscape?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  autoFocus?: boolean;
  lineNumbers?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Keep callbacks fresh without rebuilding the editor.
  const callbacks = useRef({ onChange, onRun, onShiftRun, onEscape, onFocus, onBlur });
  callbacks.current = { onChange, onRun, onShiftRun, onEscape, onFocus, onBlur };

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        Prec.high(
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                callbacks.current.onRun?.();
                return true;
              },
            },
            {
              key: "Shift-Enter",
              run: () => {
                if (!callbacks.current.onShiftRun) return false;
                callbacks.current.onShiftRun();
                return true;
              },
            },
            {
              key: "Escape",
              run: (v) => {
                if (!callbacks.current.onEscape) return false;
                v.contentDOM.blur();
                callbacks.current.onEscape();
                return true;
              },
            },
          ]),
        ),
        showLineNumbers ? lineNumbers() : [],
        highlightActiveLineGutter(),
        foldGutter(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        indentUnit.of(language === "python" ? "    " : "  "),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        languageExtension(language),
        loomTheme,
        syntaxHighlighting(loomHighlight),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            callbacks.current.onChange(update.state.doc.toString());
          }
          if (update.focusChanged) {
            if (update.view.hasFocus) callbacks.current.onFocus?.();
            else callbacks.current.onBlur?.();
          }
        }),
        EditorView.theme({
          ".cm-content": { minHeight: `${minRows * 20}px` },
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    if (autoFocus) v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
    // Rebuild only when the language changes; doc updates flow through below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // External value changes (template swaps, load) sync into the editor.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div className="cm-host" ref={host} />;
}
