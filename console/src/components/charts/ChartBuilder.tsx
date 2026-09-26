// Observable-style chart picker: choose a mark, then map columns to x / y /
// colour with sensible defaults suggested from the data. The spec is small
// JSON that notebooks persist with the cell.
import {
  ChartBar,
  ChartBarHorizontal,
  ChartLine,
  ChartPieSlice,
  ChartScatter,
  Lightning,
  Rows,
  Waves,
} from "@phosphor-icons/react";
import { useMemo } from "react";
import Chart from "./Chart";
import { inferColumns, suggestSpec, type ChartSpec, type ColumnInfo, type Mark, type Row } from "./data";

const MARKS: Array<{ mark: Mark; label: string; icon: React.ReactNode }> = [
  { mark: "bar", label: "Bar", icon: <ChartBar size={18} /> },
  { mark: "hbar", label: "Horizontal", icon: <ChartBarHorizontal size={18} /> },
  { mark: "line", label: "Line", icon: <ChartLine size={18} /> },
  { mark: "area", label: "Area", icon: <Waves size={18} /> },
  { mark: "scatter", label: "Scatter", icon: <ChartScatter size={18} /> },
  { mark: "pie", label: "Donut", icon: <ChartPieSlice size={18} /> },
  { mark: "histogram", label: "Histogram", icon: <Rows size={18} /> },
];

export function defaultSpec(rows: Row[], cols?: ColumnInfo[]): ChartSpec | null {
  return suggestSpec(cols ?? inferColumns(rows), rows);
}

export default function ChartBuilder({
  rows,
  spec,
  onChange,
  columns,
  height = 300,
}: {
  rows: Row[];
  spec: ChartSpec;
  onChange: (s: ChartSpec) => void;
  columns?: ColumnInfo[];
  height?: number;
}) {
  const cols = useMemo(() => columns ?? inferColumns(rows), [columns, rows]);
  const numeric = cols.filter((c) => c.type === "number");
  const dimensions = cols.filter((c) => c.type !== "object");
  const set = (patch: Partial<ChartSpec>) => onChange({ ...spec, ...patch });
  const isBand = spec.mark === "bar" || spec.mark === "hbar" || spec.mark === "pie";
  const multiY = spec.mark !== "pie" && spec.mark !== "scatter" && spec.mark !== "histogram" && !spec.color;

  return (
    <div className="chart-builder">
      <div className="cb-side">
        <div className="cb-field">
          <span>Mark</span>
          <div className="mark-grid">
            {MARKS.map((m) => (
              <button
                key={m.mark}
                className={`mark-btn${spec.mark === m.mark ? " on" : ""}`}
                title={m.label}
                onClick={() => {
                  const next: ChartSpec = { ...spec, mark: m.mark };
                  if (m.mark === "histogram") {
                    next.x = numeric.some((c) => c.name === spec.x) ? spec.x : (numeric[0]?.name ?? spec.x);
                    next.y = [];
                    next.bins = next.bins ?? 20;
                  } else if (spec.y.length === 0) {
                    next.y = numeric[0] ? [numeric[0].name] : [];
                  }
                  if (m.mark === "scatter") {
                    next.agg = "none";
                    next.x = numeric.find((c) => c.name !== next.y[0])?.name ?? next.x;
                  }
                  onChange(next);
                }}
              >
                {m.icon}
                {m.label}
              </button>
            ))}
            <button
              className="mark-btn"
              title="Suggest a chart from the data"
              onClick={() => {
                const s = defaultSpec(rows, cols);
                if (s) onChange(s);
              }}
            >
              <Lightning size={18} />
              Auto
            </button>
          </div>
        </div>

        <div className="cb-field">
          <span>{spec.mark === "histogram" ? "Values" : spec.mark === "pie" ? "Slices" : "X axis"}</span>
          <select value={spec.x} onChange={(e) => set({ x: e.target.value })}>
            {(spec.mark === "histogram" ? numeric : dimensions).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {spec.mark === "histogram" ? (
          <div className="cb-field">
            <span>Bins: {spec.bins ?? 20}</span>
            <input type="range" min={4} max={60} value={spec.bins ?? 20} onChange={(e) => set({ bins: Number(e.target.value) })} />
          </div>
        ) : (
          <div className="cb-field">
            <span>{spec.mark === "pie" ? "Size" : "Y axis"}</span>
            {(multiY ? spec.y : spec.y.slice(0, 1)).map((y, i) => (
              <div className="cb-row" key={i}>
                <select
                  value={y}
                  onChange={(e) => {
                    const ys = [...spec.y];
                    ys[i] = e.target.value;
                    set({ y: ys });
                  }}
                >
                  {numeric.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {multiY && spec.y.length > 1 && (
                  <button className="btn icon sm ghost" title="Remove" onClick={() => set({ y: spec.y.filter((_, j) => j !== i) })}>
                    ×
                  </button>
                )}
              </div>
            ))}
            {spec.y.length === 0 && numeric[0] && (
              <button className="btn sm" onClick={() => set({ y: [numeric[0].name] })}>Pick a measure</button>
            )}
            {multiY && spec.y.length > 0 && spec.y.length < numeric.length && spec.y.length < 8 && (
              <button
                className="btn sm ghost"
                style={{ justifyContent: "flex-start" }}
                onClick={() => set({ y: [...spec.y, numeric.find((c) => !spec.y.includes(c.name))!.name] })}
              >
                + add measure
              </button>
            )}
          </div>
        )}

        {spec.mark !== "histogram" && spec.mark !== "pie" && (
          <div className="cb-field">
            <span>Color by</span>
            <select value={spec.color ?? ""} onChange={(e) => set({ color: e.target.value || undefined, y: spec.y.slice(0, 1) })}>
              <option value="">none</option>
              {dimensions
                .filter((c) => c.name !== spec.x && c.distinct <= 64)
                .map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.distinct})
                  </option>
                ))}
            </select>
          </div>
        )}

        {spec.mark !== "histogram" && spec.mark !== "scatter" && (
          <div className="cb-field">
            <span>Aggregate</span>
            <select value={spec.agg ?? "none"} onChange={(e) => set({ agg: e.target.value as ChartSpec["agg"] })}>
              <option value="none">none (as is)</option>
              <option value="sum">sum</option>
              <option value="avg">average</option>
              <option value="median">median</option>
              <option value="count">count</option>
              <option value="min">min</option>
              <option value="max">max</option>
            </select>
          </div>
        )}

        {isBand && spec.mark !== "pie" && (
          <div className="cb-row">
            <div className="cb-field" style={{ flex: 1 }}>
              <span>Sort</span>
              <select value={spec.sort ?? "none"} onChange={(e) => set({ sort: e.target.value as ChartSpec["sort"] })}>
                <option value="none">data order</option>
                <option value="x">label</option>
                <option value="y-desc">value ↓</option>
                <option value="y-asc">value ↑</option>
              </select>
            </div>
            <div className="cb-field" style={{ width: 70 }}>
              <span>Top</span>
              <input type="number" min={1} value={spec.limit ?? ""} placeholder="all" onChange={(e) => set({ limit: e.target.value ? Number(e.target.value) : undefined })} />
            </div>
          </div>
        )}

        <div className="cb-field" style={{ gap: 6 }}>
          {(spec.mark === "bar" || spec.mark === "hbar" || spec.mark === "area") && (
            <label className="cb-check">
              <input type="checkbox" checked={!!spec.stack} onChange={(e) => set({ stack: e.target.checked })} /> Stack series
            </label>
          )}
          {(spec.mark === "bar" || spec.mark === "hbar") && spec.stack && (
            <label className="cb-check">
              <input type="checkbox" checked={!!spec.normalize} onChange={(e) => set({ normalize: e.target.checked })} /> Normalize to 100%
            </label>
          )}
          {spec.mark !== "pie" && spec.mark !== "histogram" && (
            <label className="cb-check">
              <input type="checkbox" checked={!!spec.logY} onChange={(e) => set({ logY: e.target.checked })} /> Log scale
            </label>
          )}
          {spec.mark !== "pie" && spec.mark !== "scatter" && (
            <label className="cb-check">
              <input type="checkbox" checked={!!spec.labels} onChange={(e) => set({ labels: e.target.checked })} /> Value labels
            </label>
          )}
        </div>
      </div>
      <div className="cb-main">
        <Chart rows={rows} spec={spec} height={height} columns={cols} />
      </div>
    </div>
  );
}
