// Shared renderer for query / execution results: tabular data gets the data
// grid + chart builder; everything else a JSON tree or a scalar readout.
import { ChartBar, Code, SlidersHorizontal, Table } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { ChartConfig } from "../types";
import ChartBuilder, { defaultSpec } from "./charts/ChartBuilder";
import { inferColumns, type Row } from "./charts/data";
import DataGrid from "./DataGrid";
import JsonView from "./JsonView";

export function rowsOf(value: unknown): Row[] | null {
  if (Array.isArray(value) && value.length > 0 && value.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
    return value as Row[];
  }
  return null;
}

/** Older notebooks stored `{kind, x, y}`; lift them into the new spec. */
export function migrateChart(c: unknown): ChartConfig | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  if (typeof o.kind === "string" && typeof o.x === "string" && typeof o.y === "string") {
    return { mark: o.kind === "line" ? "line" : "bar", x: o.x, y: [o.y] };
  }
  if (typeof o.mark === "string" && typeof o.x === "string" && Array.isArray(o.y)) {
    // Newer optional fields (stats / band / colors / radarAxes) are ignored
    // by older renderers and validated here so a malformed value can't
    // break the chart. Keep the original reference when nothing is wrong so
    // memoised series preparation is not redone every render.
    const badStats = o.stats !== undefined && !(Array.isArray(o.stats) && o.stats.every((s) => typeof s === "string"));
    const badColors = o.colors !== undefined && (typeof o.colors !== "object" || o.colors === null || Array.isArray(o.colors));
    if (!badStats && !badColors) return o as unknown as ChartConfig;
    const spec = { ...o } as Record<string, unknown>;
    if (badStats) delete spec.stats;
    if (badColors) delete spec.colors;
    return spec as unknown as ChartConfig;
  }
  return null;
}

export type ResultTab = "table" | "chart" | "json";

export default function ResultView({
  value,
  chart,
  onChart,
  view,
  onView,
  filename,
  maxHeight,
}: {
  value: unknown;
  chart?: ChartConfig | null;
  onChart?: (c: ChartConfig | null) => void;
  /** Controlled active tab (persisted by notebooks); uncontrolled otherwise. */
  view?: ResultTab;
  onView?: (v: ResultTab) => void;
  filename?: string;
  maxHeight?: number;
}) {
  const rows = rowsOf(value);
  const cols = useMemo(() => (rows ? inferColumns(rows) : []), [rows]);
  const [localView, setLocalView] = useState<ResultTab>(chart ? "chart" : "table");
  const [localChart, setLocalChart] = useState<ChartConfig | null>(migrateChart(chart));
  // Chart controls start hidden when a page opens on a chart; picking the
  // Chart tab opens them. Not persisted.
  const [showControls, setShowControls] = useState(false);
  const active = view ?? localView;
  const spec = onChart ? migrateChart(chart) : localChart;
  const setView = (v: ResultTab) => {
    setLocalView(v);
    onView?.(v);
  };
  const setChart = (c: ChartConfig | null) => {
    setLocalChart(c);
    onChart?.(c);
  };

  if (!rows) {
    if (value === null || value === undefined || typeof value !== "object") {
      return <div className="scalar-out">{value === undefined ? "undefined" : JSON.stringify(value)}</div>;
    }
    return <JsonView value={value} />;
  }

  const numericCount = cols.filter((c) => c.type === "number").length;
  return (
    <div className="result-frame">
      <div className="result-tabs">
        <div className="seg">
          <button className={active === "table" ? "on" : ""} onClick={() => setView("table")}>
            <Table size={13} /> Table
          </button>
          <button
            className={active === "chart" ? "on" : ""}
            disabled={numericCount === 0}
            title={numericCount === 0 ? "No numeric columns to chart" : "Chart"}
            onClick={() => {
              if (!spec) setChart(defaultSpec(rows, cols));
              if (active !== "chart") setShowControls(true);
              setView("chart");
            }}
          >
            <ChartBar size={13} /> Chart
          </button>
          <button className={active === "json" ? "on" : ""} onClick={() => setView("json")}>
            <Code size={13} /> JSON
          </button>
        </div>
        <span className="grow" />
        {active === "chart" && spec && (
          <button
            className={showControls ? "btn sm" : "btn sm ghost"}
            onClick={() => setShowControls((s) => !s)}
            title={showControls ? "Hide chart controls" : "Show chart controls"}
            aria-pressed={showControls}
          >
            <SlidersHorizontal size={13} /> {showControls ? "Hide controls" : "Controls"}
          </button>
        )}
        <span>
          {rows.length.toLocaleString()} rows · {cols.length} cols
        </span>
      </div>
      {active === "table" && <DataGrid rows={rows} columns={cols} filename={filename} maxHeight={maxHeight} />}
      {active === "chart" && (spec ? <ChartBuilder rows={rows} spec={spec} columns={cols} onChange={setChart} controls={showControls} /> : <div className="chart-empty">No numeric columns to plot.</div>)}
      {active === "json" && (
        <div style={{ padding: 8 }}>
          <JsonView value={rows.length > 200 ? rows.slice(0, 200) : rows} />
          {rows.length > 200 && <p className="muted small" style={{ margin: "6px 4px 0" }}>Showing the first 200 of {rows.length.toLocaleString()} rows.</p>}
        </div>
      )}
    </div>
  );
}
