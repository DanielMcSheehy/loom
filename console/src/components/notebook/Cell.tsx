// One notebook cell: gutter (run / drag), toolbar (kind, runtime, name,
// dependencies, timing, actions), editor or rendered markdown, and output.
import {
  ArrowDown,
  ArrowUp,
  CaretDown,
  CaretRight,
  Check,
  Copy,
  DotsSixVertical,
  Eye,
  EyeSlash,
  PencilSimple,
  Play,
  Spinner,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import { memo, useCallback, useRef, useState } from "react";
import type { ChartConfig, Connector, NotebookCell, ResultViewKind, RuntimeName } from "../../types";
import CodeEditor, { type CodeLanguage } from "../CodeEditor";
import type { TypeContext } from "../editor/context";
import Markdown from "../Markdown";
import { setImageWidth } from "../markdown/images";
import { appendBlock, fileToMarkdown, findEditorView, imageFiles, insertBlockAt } from "../markdown/insertImage";
import ResultView from "../ResultView";
import { CODE_TEMPLATE } from "./cells";

export interface CellProps {
  cell: NotebookCell;
  index: number;
  focused: boolean;
  running: boolean;
  queued: boolean;
  stale: boolean;
  editing: boolean;
  deps: Array<{ id: string; label: string }>;
  /** What this cell's handler receives (outputs of cells above); code cells only. */
  typeContext?: TypeContext;
  connectors: Connector[];
  onPatch: (patch: Partial<NotebookCell>) => void;
  onRun: () => void;
  onRunAdvance: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onSetEditing: (v: boolean) => void;
  onMove: (dir: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onGrab: (e: React.PointerEvent) => void;
  dropPos: "before" | "after" | null;
  dragging: boolean;
}

function Cell(p: CellProps) {
  const { cell, focused, running, queued, stale, editing, deps } = p;
  const isMd = cell.kind === "markdown";
  const runState = running ? "running" : cell.output ? (cell.output.ok ? "ok" : "err") : "";
  const language = (cell.kind === "sql" ? "sql" : isMd ? "markdown" : (cell.runtime ?? "python")) as CodeLanguage;
  const outputValue = cell.output?.ok ? (cell.output.rows ?? cell.output.result) : undefined;
  const lines = cell.code.split("\n").length;

  // Markdown images: a dragged width persists into the source as `![alt|320](url)`.
  const codeRef = useRef(cell.code);
  codeRef.current = cell.code;
  const { onPatch } = p;
  const onImageResize = useCallback(
    (index: number, width: number | null, src: string) => onPatch({ code: setImageWidth(codeRef.current, index, width, src) }),
    [onPatch],
  );

  // Pasted / dropped image files land in the markdown editor as data: URLs.
  const editorHost = useRef<HTMLDivElement>(null);
  const [embedding, setEmbedding] = useState(0);
  const [dropTarget, setDropTarget] = useState(false);
  const embedImages = useCallback(
    async (files: File[], at?: { x: number; y: number }) => {
      setEmbedding((n) => n + files.length);
      try {
        const md = (await Promise.all(files.map(fileToMarkdown))).join("\n");
        const view = await findEditorView(editorHost.current);
        if (view) insertBlockAt(view, md, at);
        else onPatch({ code: appendBlock(codeRef.current, md) });
      } finally {
        setEmbedding((n) => Math.max(0, n - files.length));
      }
    },
    [onPatch],
  );
  const mdEditorEvents = isMd
    ? {
        // Capture phase: runs before CodeMirror's own paste/drop listeners,
        // which would otherwise try to read the file as text.
        onPasteCapture: (e: React.ClipboardEvent) => {
          const files = imageFiles(e.clipboardData);
          if (files.length === 0) return;
          e.preventDefault();
          e.stopPropagation();
          void embedImages(files);
        },
        onDragOverCapture: (e: React.DragEvent) => {
          if (!e.dataTransfer?.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!dropTarget) setDropTarget(true);
        },
        onDragLeaveCapture: (e: React.DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(false);
        },
        onDropCapture: (e: React.DragEvent) => {
          setDropTarget(false);
          const files = imageFiles(e.dataTransfer);
          if (files.length === 0) return;
          e.preventDefault();
          e.stopPropagation();
          void embedImages(files, { x: e.clientX, y: e.clientY });
        },
      }
    : {};

  return (
    <div
      id={`cell-${cell.id}`}
      className={`cell ${cell.kind}${focused ? " focused" : ""}${editing ? " editing" : ""}${cell.collapsed ? " collapsed-code" : ""}${p.dragging ? " dragging" : ""}${p.dropPos ? ` drop-${p.dropPos}` : ""}`}
      data-cell-id={cell.id}
      onMouseDown={p.onFocus}
    >
      <div className="cell-gutter">
        {isMd ? (
          <button className="cell-kind-dot" title={editing ? "Render markdown" : "Edit markdown"} onClick={() => p.onSetEditing(!editing)} style={{ background: "none", cursor: "pointer" }}>
            {editing ? <Check size={13} /> : <PencilSimple size={13} />}
          </button>
        ) : (
          <button className={`cell-run ${runState}`} title="Run cell (⌘⏎)" disabled={running} onClick={p.onRun}>
            {running ? <Spinner size={14} /> : queued ? <span className="dim" style={{ fontSize: 10 }}>…</span> : <Play size={12} weight="fill" />}
          </button>
        )}
        <span className="cell-grab" title="Drag to reorder" onPointerDown={p.onGrab}>
          <DotsSixVertical size={14} />
        </span>
      </div>

      <div className="cell-main">
        {(!isMd || editing) && (
          <div className="cell-toolbar">
            <span className="cell-kind">
              {cell.kind === "code" ? (
                <select
                  className="inline"
                  style={{ height: 22, fontSize: 11, textTransform: "none", letterSpacing: 0 }}
                  value={cell.runtime ?? "python"}
                  onChange={(e) => {
                    const runtime = e.target.value as RuntimeName;
                    p.onPatch({ runtime, code: cell.code === CODE_TEMPLATE[cell.runtime ?? "python"] ? CODE_TEMPLATE[runtime] : cell.code });
                  }}
                >
                  <option value="python">Python</option>
                  <option value="typescript">TypeScript</option>
                  <option value="javascript">JavaScript</option>
                </select>
              ) : (
                cell.kind
              )}
            </span>
            {!isMd && (
              <input
                className="cell-name"
                placeholder="name this cell"
                title="Named cells expose their output to cells below as inputs[name]"
                value={cell.name ?? ""}
                spellCheck={false}
                onChange={(e) => p.onPatch({ name: e.target.value.replace(/[^\w-]/g, "") || undefined })}
              />
            )}
            {cell.kind === "sql" && p.connectors.length > 0 && (
              <select className="inline" value={cell.connector ?? ""} onChange={(e) => p.onPatch({ connector: e.target.value || undefined })}>
                <option value="">datasets (polars)</option>
                {p.connectors.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} · {c.kind}
                  </option>
                ))}
              </select>
            )}
            {deps.length > 0 && (
              <span className="cell-deps" title="Cells this one reads from">
                ← {deps.map((d) => (
                  <a key={d.id} className="dep" href={`#cell-${d.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(`cell-${d.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }}>
                    {d.label}
                  </a>
                ))}
              </span>
            )}
            <span className="grow" />
            {stale && !running && (
              <span className="cell-stale" title="Code or inputs changed since this output was produced">
                <Warning size={12} /> stale
              </span>
            )}
            {cell.output?.elapsed_ms !== undefined && !running && <span className="cell-time">{cell.output.elapsed_ms < 1000 ? `${cell.output.elapsed_ms}ms` : `${(cell.output.elapsed_ms / 1000).toFixed(1)}s`}</span>}
            <span className="cell-actions">
              {!isMd && (
                <button title={cell.collapsed ? "Show code" : "Hide code"} onClick={() => p.onPatch({ collapsed: !cell.collapsed })}>
                  {cell.collapsed ? <Eye size={14} /> : <EyeSlash size={14} />}
                </button>
              )}
              <button title="Move up" onClick={() => p.onMove(-1)}><ArrowUp size={14} /></button>
              <button title="Move down" onClick={() => p.onMove(1)}><ArrowDown size={14} /></button>
              <button title="Duplicate" onClick={p.onDuplicate}><Copy size={14} /></button>
              {isMd && <button title="Done editing" onClick={() => p.onSetEditing(false)}><Check size={14} /></button>}
              <button className="danger" title="Delete cell" onClick={p.onDelete}><Trash size={14} /></button>
            </span>
          </div>
        )}

        {isMd && !editing ? (
          <div onDoubleClick={() => p.onSetEditing(true)} style={{ position: "relative" }}>
            <Markdown source={cell.code || "*Empty markdown cell. Double-click to edit.*"} onImageResize={onImageResize} />
            <span className="cell-actions" style={{ position: "absolute", top: 4, right: 0 }}>
              <button title="Edit" onClick={() => p.onSetEditing(true)}><PencilSimple size={14} /></button>
              <button title="Move up" onClick={() => p.onMove(-1)}><ArrowUp size={14} /></button>
              <button title="Move down" onClick={() => p.onMove(1)}><ArrowDown size={14} /></button>
              <button className="danger" title="Delete cell" onClick={p.onDelete}><Trash size={14} /></button>
            </span>
          </div>
        ) : cell.collapsed && !isMd ? (
          <div className="cell-code-collapsed" onClick={() => p.onPatch({ collapsed: false })}>
            <CaretRight size={11} /> {lines} line{lines === 1 ? "" : "s"} of {cell.kind === "sql" ? "SQL" : cell.runtime} hidden
          </div>
        ) : (
          <div className={`cell-editor${dropTarget ? " md-drop-target" : ""}`} ref={editorHost} style={isMd ? { position: "relative" } : undefined} {...mdEditorEvents}>
            {embedding > 0 && <span className="md-embedding">embedding image…</span>}
            <CodeEditor
              value={cell.code}
              language={language}
              minRows={isMd ? 3 : 4}
              autoFocus={isMd && editing}
              onChange={(code) => p.onPatch({ code })}
              onRun={isMd ? () => p.onSetEditing(false) : p.onRun}
              onShiftRun={isMd ? () => { p.onSetEditing(false); p.onRunAdvance(); } : p.onRunAdvance}
              onEscape={isMd ? () => p.onSetEditing(false) : p.onBlur}
              onFocus={p.onFocus}
              typeContext={cell.kind === "code" ? p.typeContext : undefined}
            />
          </div>
        )}

        {cell.output && !isMd && (
          <div className="cell-output">
            {cell.output.logs && cell.output.logs.length > 0 && <pre className="cell-logs">{cell.output.logs.join("\n")}</pre>}
            {!cell.output.ok && (
              <div className="cell-error">
                <div className="msg"><X size={13} style={{ verticalAlign: -2 }} /> {cell.output.error}</div>
                {cell.output.trace && (
                  <details>
                    <summary>Stack trace</summary>
                    <pre>{cell.output.trace}</pre>
                  </details>
                )}
              </div>
            )}
            {cell.output.ok && outputValue !== undefined && (
              <div className="out-pad">
                <ResultView
                  value={outputValue}
                  chart={cell.chart ?? null}
                  onChart={(chart: ChartConfig | null) => p.onPatch({ chart })}
                  view={cell.view}
                  onView={(view: ResultViewKind) => p.onPatch({ view })}
                  filename={cell.name || `cell-${p.index + 1}`}
                />
                {cell.output.truncated && (
                  <p className="muted small" style={{ margin: "6px 2px 0" }}>
                    Result truncated to {cell.output.rows?.length.toLocaleString()} rows. Add a LIMIT or aggregate.
                  </p>
                )}
              </div>
            )}
            {cell.output.ok && outputValue === undefined && (
              <div className="out-pad muted small">
                <CaretDown size={11} /> handler returned nothing
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(Cell);
