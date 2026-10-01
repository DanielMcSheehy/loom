// A notebook cell as a visitor sees it in a published notebook: rendered
// markdown, highlighted code (Prism — never the editor), and the output
// stored with the document. Nothing here talks to the server.
import { CaretDown, CaretRight, Eye, EyeSlash, X } from "@phosphor-icons/react";
import { memo, useState } from "react";
import type { NotebookCell } from "../../types";
import { CodeBlock, type CodeLanguage } from "../CodeBlock";
import Markdown from "../Markdown";
import ResultView from "../ResultView";

function ReadOnlyCell({ cell, index }: { cell: NotebookCell; index: number }) {
  const isMd = cell.kind === "markdown";
  // "Hide code" is the author's presentation choice; a reader may still peek.
  const [showCode, setShowCode] = useState(!cell.collapsed);

  if (isMd) {
    if (!cell.code.trim()) return null;
    return (
      <div id={`cell-${cell.id}`} className="cell markdown readonly">
        <div className="cell-main">
          <Markdown source={cell.code} />
        </div>
      </div>
    );
  }

  const language = (cell.kind === "sql" ? "sql" : (cell.runtime ?? "python")) as CodeLanguage;
  const output = cell.output;
  const value = output?.ok ? (output.rows ?? output.result) : undefined;
  const lines = cell.code.split("\n").length;

  return (
    <div id={`cell-${cell.id}`} className={`cell ${cell.kind} readonly`}>
      <div className="cell-main">
        <div className="cell-toolbar">
          <span className="cell-kind">{cell.kind === "sql" ? "sql" : (cell.runtime ?? "python")}</span>
          {cell.name && <span className="cell-name-static">{cell.name}</span>}
          <span className="grow" />
          {output?.elapsed_ms !== undefined && (
            <span className="cell-time">{output.elapsed_ms < 1000 ? `${output.elapsed_ms}ms` : `${(output.elapsed_ms / 1000).toFixed(1)}s`}</span>
          )}
          <span className="cell-actions">
            <button title={showCode ? "Hide code" : "Show code"} onClick={() => setShowCode((s) => !s)}>
              {showCode ? <EyeSlash size={14} /> : <Eye size={14} />}
            </button>
          </span>
        </div>

        {showCode ? (
          <CodeBlock code={cell.code} language={language} className="cell-code-static" />
        ) : (
          <div className="cell-code-collapsed" onClick={() => setShowCode(true)}>
            <CaretRight size={11} /> {lines} line{lines === 1 ? "" : "s"} of {cell.kind === "sql" ? "SQL" : cell.runtime} hidden
          </div>
        )}

        {output && (
          <div className="cell-output">
            {output.logs && output.logs.length > 0 && <pre className="cell-logs">{output.logs.join("\n")}</pre>}
            {!output.ok && (
              <div className="cell-error">
                <div className="msg"><X size={13} style={{ verticalAlign: -2 }} /> {output.error}</div>
                {output.trace && (
                  <details>
                    <summary>Stack trace</summary>
                    <pre>{output.trace}</pre>
                  </details>
                )}
              </div>
            )}
            {output.ok && value !== undefined && (
              <div className="out-pad">
                <ResultView value={value} chart={cell.chart ?? null} initialView={cell.view} filename={cell.name || `cell-${index + 1}`} readOnly />
                {output.truncated && (
                  <p className="muted small" style={{ margin: "6px 2px 0" }}>
                    Result truncated to {output.rows?.length.toLocaleString()} rows.
                  </p>
                )}
              </div>
            )}
            {output.ok && value === undefined && (
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

export default memo(ReadOnlyCell);
