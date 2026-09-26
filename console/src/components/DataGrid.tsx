// Data table with Observable-style column summaries: type icon, a mini
// histogram / top-values bar per column, sort, filter, paging, CSV export.
import {
  ArrowDown,
  ArrowUp,
  Calendar,
  DownloadSimple,
  Hash,
  MagnifyingGlass,
  TextT,
  ToggleLeft,
  Tree,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { download, toCsv } from "../api";
import { inferColumns, type ColType, type ColumnInfo, type Row } from "./charts/data";

export function TypeIcon({ type, size = 12 }: { type: ColType; size?: number }) {
  const cls = "type-ico";
  switch (type) {
    case "number":
      return <Hash size={size} className={cls} />;
    case "date":
      return <Calendar size={size} className={cls} />;
    case "boolean":
      return <ToggleLeft size={size} className={cls} />;
    case "object":
      return <Tree size={size} className={cls} />;
    default:
      return <TextT size={size} className={cls} />;
  }
}

function fmtCell(v: unknown): { text: string; cls: string } {
  if (v === null || v === undefined) return { text: "null", cls: "null" };
  if (typeof v === "number") return { text: Number.isInteger(v) ? v.toLocaleString() : String(Number(v.toFixed(6))), cls: "n" };
  if (typeof v === "boolean") return { text: String(v), cls: "b" };
  if (typeof v === "object") return { text: JSON.stringify(v), cls: "s" };
  return { text: String(v), cls: "s" };
}

function fmtStat(v: number, type: ColType): string {
  if (type === "date") return new Date(v).toLocaleDateString();
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return Number.isInteger(v) ? v.toLocaleString() : String(Number(v.toPrecision(3)));
}

function ColumnSummary({ col, total }: { col: ColumnInfo; total: number }) {
  const W = 120;
  const H = 26;
  if ((col.type === "number" || col.type === "date") && col.hist) {
    const max = Math.max(...col.hist, 1);
    const bw = W / col.hist.length;
    const modeIdx = col.hist.indexOf(max);
    return (
      <div>
        <svg className="summary" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          {col.hist.map((h, i) => (
            <rect key={i} className={`bar${i === modeIdx ? " mode" : ""}`} x={i * bw + 0.5} y={H - (h / max) * (H - 2) - 1} width={Math.max(1, bw - 1)} height={(h / max) * (H - 2)} rx={1} />
          ))}
        </svg>
        <div className="stat">
          {fmtStat(col.min ?? 0, col.type)} – {fmtStat(col.max ?? 0, col.type)}
        </div>
      </div>
    );
  }
  if (col.type === "boolean") {
    const r = col.trueRatio ?? 0;
    return (
      <div>
        <svg className="summary" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          <rect className="cat top" x={0} y={8} width={W * r} height={10} rx={2} />
          <rect className="cat" x={W * r + (r > 0 && r < 1 ? 2 : 0)} y={8} width={Math.max(0, W * (1 - r) - 2)} height={10} rx={2} />
        </svg>
        <div className="stat">{Math.round(r * 100)}% true</div>
      </div>
    );
  }
  if (col.top && col.top.length) {
    const sum = col.top.reduce((a, t) => a + t.count, 0) + Math.max(0, total - col.nulls - col.top.reduce((a, t) => a + t.count, 0));
    let x = 0;
    return (
      <div>
        <svg className="summary" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          {col.top.map((t, i) => {
            const w = Math.max(1, (t.count / Math.max(1, sum)) * W - 2);
            const el = <rect key={t.value} className={`cat${i === 0 ? " top" : ""}`} x={x} y={8} width={w} height={10} rx={2} />;
            x += w + 2;
            return el;
          })}
          <text className="txt" x={0} y={H - 1}>
            {col.top[0].value.slice(0, 18)}
          </text>
        </svg>
        <div className="stat">{col.distinct.toLocaleString()} distinct</div>
      </div>
    );
  }
  return <div className="stat">{col.type}</div>;
}

export default function DataGrid({
  rows,
  columns,
  pageSize = 50,
  maxHeight = 460,
  summaries = true,
  filename = "result",
  dense,
}: {
  rows: Row[];
  columns?: ColumnInfo[];
  pageSize?: number;
  maxHeight?: number;
  summaries?: boolean;
  filename?: string;
  dense?: boolean;
}) {
  const cols = useMemo(() => columns ?? inferColumns(rows), [columns, rows]);
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [q, sort, rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = rows;
    if (needle) out = rows.filter((r) => Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(needle)));
    if (sort) {
      const { col, dir } = sort;
      out = [...out].sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
        return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
      });
    }
    return out;
  }, [rows, q, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const slice = filtered.slice(page * pageSize, (page + 1) * pageSize);

  const toggleSort = (name: string) =>
    setSort((s) => (s?.col === name ? (s.dir === 1 ? { col: name, dir: -1 } : null) : { col: name, dir: 1 }));

  return (
    <div className="dg">
      <div className="dg-toolbar">
        <span>
          <b style={{ color: "var(--ink)" }}>{rows.length.toLocaleString()}</b> rows × {cols.length} columns
          {filtered.length !== rows.length && ` · ${filtered.length.toLocaleString()} match`}
        </span>
        <span className="grow" />
        <span className="filter-input" style={{ display: "inline-flex", alignItems: "center" }}>
          <MagnifyingGlass size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter rows" style={{ paddingLeft: 26, width: 170 }} />
        </span>
        <button className="btn sm ghost" title="Download CSV" onClick={() => download(`${filename}.csv`, toCsv(filtered), "text/csv")}>
          <DownloadSimple size={14} /> CSV
        </button>
        <button className="btn sm ghost" title="Download JSON" onClick={() => download(`${filename}.json`, JSON.stringify(filtered, null, 2), "application/json")}>
          <DownloadSimple size={14} /> JSON
        </button>
      </div>
      <div className="dg-scroll" style={{ maxHeight }}>
        <table>
          <thead>
            <tr>
              <th className="idx" />
              {cols.map((c) => (
                <th key={c.name}>
                  <div className="h" onClick={() => toggleSort(c.name)} title={`${c.name}: ${c.type}${c.nulls ? `, ${c.nulls} nulls` : ""}`}>
                    <span className="name">
                      <TypeIcon type={c.type} />
                      {c.name}
                      {sort?.col === c.name && <span className="sort">{sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}</span>}
                    </span>
                    {summaries && !dense && <ColumnSummary col={c} total={rows.length} />}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={i}>
                <td className="idx">{page * pageSize + i + 1}</td>
                {cols.map((c) => {
                  const f = fmtCell(r[c.name]);
                  return (
                    <td key={c.name} className={f.cls} title={f.text.length > 40 ? f.text : undefined}>
                      {f.text}
                    </td>
                  );
                })}
              </tr>
            ))}
            {slice.length === 0 && (
              <tr>
                <td colSpan={cols.length + 1} className="muted" style={{ textAlign: "center", padding: 24 }}>
                  No rows match
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {(pages > 1 || rows.length > pageSize) && (
        <div className="dg-foot">
          <span>
            {page * pageSize + 1}–{Math.min(filtered.length, (page + 1) * pageSize)} of {filtered.length.toLocaleString()}
          </span>
          <span className="grow" />
          <button disabled={page === 0} onClick={() => setPage(0)}>first</button>
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>prev</button>
          <span>
            page {page + 1} / {pages}
          </span>
          <button disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>next</button>
          <button disabled={page >= pages - 1} onClick={() => setPage(pages - 1)}>last</button>
        </div>
      )}
    </div>
  );
}
