// Responsive SVG chart: bar / horizontal bar / line / area / scatter / pie /
// histogram over row objects. One hue per series from the categorical
// palette, thin marks, recessive grid, hover tooltip + crosshair, clickable
// legend. Colours come from CSS tokens so both themes work.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatNumber } from "../../api";
import {
  fmtTimeFull,
  inferColumns,
  niceTicks,
  prepare,
  timeTicks,
  type ChartSpec,
  type ColumnInfo,
  type Prepared,
  type Row,
} from "./data";

export const seriesColor = (slot: number) => `var(--s${(slot % 8) + 1})`;

export function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.floor(e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

interface Tooltip {
  px: number;
  py: number;
  title: string;
  rows: Array<{ name: string; color: string; value: string }>;
  cx?: number;
  marks?: Array<{ x: number; y: number; color: string }>;
}

export type ColorOf = (s: { name: string; slot: number }) => string;

export default function Chart({
  rows,
  spec,
  height = 280,
  columns,
  compact,
  colors,
}: {
  rows: Row[];
  spec: ChartSpec;
  height?: number;
  columns?: ColumnInfo[];
  compact?: boolean;
  /** Fixed colours by series name (e.g. run states); others use the palette. */
  colors?: Record<string, string>;
}) {
  const colorOf: ColorOf = (s) => colors?.[s.name] ?? seriesColor(s.slot);
  const [ref, width] = useWidth<HTMLDivElement>();
  const cols = useMemo(() => columns ?? inferColumns(rows), [columns, rows]);
  const prepared = useMemo(() => prepare(rows, spec, cols), [rows, spec, cols]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [tip, setTip] = useState<Tooltip | null>(null);
  useEffect(() => setHidden(new Set()), [spec.mark, spec.x, spec.color, spec.y.join("|")]);

  const visible = useMemo(
    () => ({ ...prepared, series: prepared.series.filter((s) => !hidden.has(s.name)) }),
    [prepared, hidden],
  );

  if (prepared.series.length === 0 || prepared.series.every((s) => s.points.length === 0)) {
    return (
      <div className="chart" ref={ref}>
        <div className="chart-empty">Nothing to plot. Pick a numeric measure for the y axis.</div>
      </div>
    );
  }

  const legend =
    prepared.series.length > 1 ? (
      <div className="legend" style={{ padding: compact ? "4px 0 0" : "8px 0 0" }}>
        {prepared.series.map((s) => (
          <span
            key={s.name}
            className={`item${hidden.has(s.name) ? " off" : ""}`}
            onClick={() =>
              setHidden((h) => {
                const n = new Set(h);
                if (n.has(s.name)) n.delete(s.name);
                else n.add(s.name);
                return n;
              })
            }
          >
            <span className="swatch" style={{ background: colorOf(s) }} />
            {s.name}
          </span>
        ))}
      </div>
    ) : null;

  return (
    <div className="chart" ref={ref}>
      {width > 0 &&
        (spec.mark === "pie" ? (
          <Pie prepared={visible} width={width} height={height} setTip={setTip} colorOf={colorOf} />
        ) : spec.mark === "hbar" ? (
          <HBars prepared={visible} width={width} height={height} spec={spec} setTip={setTip} colorOf={colorOf} />
        ) : (
          <XY prepared={visible} width={width} height={height} spec={spec} setTip={setTip} tip={tip} colorOf={colorOf} />
        ))}
      {legend}
      {tip && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(Math.max(0, tip.px + 14), Math.max(0, width - 180)),
            top: Math.max(0, tip.py - 10),
          }}
        >
          <div className="tt-title">{tip.title}</div>
          {tip.rows.map((r) => (
            <div className="tt-row" key={r.name}>
              <span className="swatch" style={{ background: r.color }} />
              {r.name}
              <b>{r.value}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── cartesian charts ──────────────────────────────────────────────────

function XY({
  prepared,
  width,
  height,
  spec,
  setTip,
  tip,
  colorOf,
}: {
  prepared: Prepared;
  width: number;
  height: number;
  spec: ChartSpec;
  setTip: (t: Tooltip | null) => void;
  tip: Tooltip | null;
  colorOf: ColorOf;
}) {
  const { series, xType, categories, stacked } = prepared;
  const isBar = spec.mark === "bar" || spec.mark === "histogram";
  const isArea = spec.mark === "area";
  const isScatter = spec.mark === "scatter";

  // y domain
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const s of series)
    for (const p of s.points) {
      const lo = p.y0 ?? p.y;
      if (lo < yMin) yMin = lo;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
  if (!Number.isFinite(yMin)) {
    yMin = 0;
    yMax = 1;
  }
  const logY = !!spec.logY && yMin > 0;
  if (isBar || isArea) {
    if (!logY) {
      yMin = Math.min(0, yMin);
      yMax = Math.max(0, yMax);
    }
  } else if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  } else {
    const pad = (yMax - yMin) * 0.06;
    yMin -= pad;
    yMax += pad;
  }
  const yTicks = logY ? logTicks(yMin, yMax) : niceTicks(yMin, yMax, height < 200 ? 3 : 5);
  if (yTicks.length && !logY) {
    yMin = Math.min(yMin, yTicks[0]);
    yMax = Math.max(yMax, yTicks[yTicks.length - 1]);
  }
  const tickLabelW = Math.max(...yTicks.map((t) => fmtVal(t).length), 2) * 6.6 + 12;
  const M = { top: 14, right: 16, bottom: 32, left: Math.min(80, Math.max(34, tickLabelW)) };
  const innerW = Math.max(10, width - M.left - M.right);
  const innerH = Math.max(10, height - M.top - M.bottom);
  const ySc = (v: number) => {
    if (logY) {
      const a = Math.log10(yMin);
      const b = Math.log10(yMax);
      return M.top + innerH - ((Math.log10(Math.max(v, yMin)) - a) / (b - a || 1)) * innerH;
    }
    return M.top + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH;
  };

  // x scale
  let xMin = Infinity;
  let xMax = -Infinity;
  if (xType !== "band") {
    for (const s of series)
      for (const p of s.points) {
        const x = p.x as number;
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
    if (xMin === xMax) {
      xMin -= 1;
      xMax += 1;
    }
    if (isScatter) {
      const pad = (xMax - xMin) * 0.04;
      xMin -= pad;
      xMax += pad;
    }
  }
  const n = categories.length;
  const band = n ? innerW / n : innerW;
  const xSc = (x: number | string, i?: number) =>
    xType === "band"
      ? M.left + (i ?? categories.indexOf(x as string)) * band + band / 2
      : M.left + (((x as number) - xMin) / (xMax - xMin || 1)) * innerW;

  // x ticks
  let xTicks: Array<{ x: number; label: string }> = [];
  if (xType === "band") {
    const maxLabels = Math.max(2, Math.floor(innerW / 64));
    const every = Math.ceil(n / maxLabels);
    xTicks = categories.map((c, i) => ({ x: xSc(c, i), label: c })).filter((_, i) => i % every === 0);
  } else if (xType === "time") {
    xTicks = timeTicks(xMin, xMax, Math.max(2, Math.floor(innerW / 90))).map((t) => ({ x: xSc(t.v), label: t.label }));
  } else {
    xTicks = niceTicks(xMin, xMax, Math.max(2, Math.floor(innerW / 80))).map((v) => ({ x: xSc(v), label: fmtVal(v) }));
  }
  const rotate = xType === "band" && xTicks.some((t) => t.label.length * 6.4 > band * Math.ceil(n / Math.max(1, xTicks.length)) - 6);

  const zeroY = logY || yMin > 0 || yMax < 0 ? M.top + innerH : ySc(0);
  const groupCount = stacked ? 1 : series.length;
  const barW = Math.max(2, Math.min(24, (band * 0.72) / groupCount - (groupCount > 1 ? 2 : 0)));
  const groupW = barW * groupCount + (groupCount - 1) * 2;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (isScatter) {
      let best: { d: number; s: (typeof series)[0]; p: (typeof series)[0]["points"][0] } | null = null;
      for (const s of series)
        for (const p of s.points) {
          const dx = xSc(p.x) - px;
          const dy = ySc(p.y) - py;
          const d = dx * dx + dy * dy;
          if (!best || d < best.d) best = { d, s, p };
        }
      if (!best || best.d > 40 * 40) return setTip(null);
      const cx = xSc(best.p.x);
      const cy = ySc(best.p.y);
      setTip({
        px: cx,
        py: cy,
        title: xType === "time" ? fmtTimeFull(best.p.x as number) : `${spec.x}: ${fmtVal(best.p.x as number)}`,
        rows: [{ name: best.s.name, color: colorOf(best.s), value: fmtVal(best.p.y) }],
        marks: [{ x: cx, y: cy, color: colorOf(best.s) }],
      });
      return;
    }
    let key: string | number | null = null;
    let cx = px;
    if (xType === "band") {
      const i = Math.floor((px - M.left) / band);
      if (i < 0 || i >= n) return setTip(null);
      key = categories[i];
      cx = xSc(key, i);
    } else {
      // nearest x among all points
      let bestD = Infinity;
      for (const s of series)
        for (const p of s.points) {
          const d = Math.abs(xSc(p.x) - px);
          if (d < bestD) {
            bestD = d;
            key = p.x;
          }
        }
      if (key === null || bestD > 60) return setTip(null);
      cx = xSc(key);
    }
    const rows: Tooltip["rows"] = [];
    const marks: Tooltip["marks"] = [];
    for (const s of series) {
      const p = s.points.find((q) => q.x === key);
      if (!p) continue;
      const val = stacked ? p.y - (p.y0 ?? 0) : p.y;
      rows.push({ name: s.name, color: colorOf(s), value: fmtVal(val) + (spec.normalize ? "%" : "") });
      marks.push({ x: cx, y: ySc(p.y), color: colorOf(s) });
    }
    if (!rows.length) return setTip(null);
    setTip({
      px: cx,
      py: Math.min(py, height - 20),
      title: xType === "time" ? fmtTimeFull(key as number) : String(key),
      rows,
      cx,
      marks: isBar ? undefined : marks,
    });
  };

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`${spec.mark} chart of ${spec.y.join(", ")} by ${spec.x}`}>
      <g className="grid">
        {yTicks.map((t) => (
          <line key={t} x1={M.left} x2={width - M.right} y1={ySc(t)} y2={ySc(t)} />
        ))}
      </g>
      <g className="axis">
        <line x1={M.left} x2={width - M.right} y1={zeroY} y2={zeroY} />
      </g>
      <g className="tick">
        {yTicks.map((t) => (
          <text key={t} x={M.left - 8} y={ySc(t) + 3.5} textAnchor="end">
            {fmtVal(t)}
            {spec.normalize ? "%" : ""}
          </text>
        ))}
        {xTicks.map((t, i) =>
          rotate ? (
            <text key={i} transform={`translate(${t.x},${M.top + innerH + 10}) rotate(-32)`} textAnchor="end">
              {trunc(t.label, 16)}
            </text>
          ) : (
            <text key={i} x={t.x} y={M.top + innerH + 18} textAnchor="middle">
              {trunc(t.label, 14)}
            </text>
          ),
        )}
      </g>

      {/* marks */}
      {series.map((s, si) => {
        const color = colorOf(s);
        if (isBar) {
          const offset = stacked ? -barW / 2 : -groupW / 2 + si * (barW + 2);
          return (
            <g key={s.name}>
              {s.points.map((p, i) => {
                const x = xSc(p.x, categories.indexOf(p.x as string)) + offset;
                const y1 = ySc(p.y);
                const y0 = ySc(p.y0 ?? (logY ? yMin : 0));
                const top = Math.min(y0, y1);
                const h = Math.max(0.5, Math.abs(y0 - y1));
                const gap = stacked && p.y0 ? 2 : 0;
                return <path key={i} d={roundedBar(x, top + gap, barW, Math.max(0, h - gap), p.y >= (p.y0 ?? 0) ? "top" : "bottom", 4)} fill={color} />;
              })}
              {spec.labels && s.points.length <= 40 && !stacked && (
                <g className="tick">
                  {s.points.map((p, i) => (
                    <text key={i} x={xSc(p.x, categories.indexOf(p.x as string)) + offset + barW / 2} y={ySc(p.y) - 5} textAnchor="middle" style={{ fontSize: 10.5 }}>
                      {fmtVal(p.y)}
                    </text>
                  ))}
                </g>
              )}
            </g>
          );
        }
        if (isScatter) {
          return (
            <g key={s.name}>
              {s.points.map((p, i) => (
                <circle key={i} cx={xSc(p.x)} cy={ySc(p.y)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
              ))}
            </g>
          );
        }
        // line / area
        const pts = s.points.map((p) => [xSc(p.x, categories.indexOf(p.x as string)), ySc(p.y), ySc(p.y0 ?? (logY ? yMin : 0))]);
        const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
        const areaD = isArea && pts.length
          ? `${d} ${[...pts].reverse().map(([x, , y0]) => `L${x.toFixed(1)},${y0.toFixed(1)}`).join(" ")} Z`
          : null;
        const last = s.points[s.points.length - 1];
        return (
          <g key={s.name}>
            {areaD && <path d={areaD} fill={color} opacity={stacked ? 0.55 : 0.12} />}
            <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {s.points.length <= 60 &&
              !stacked &&
              pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={3.5} fill={color} stroke="var(--surface)" strokeWidth={2} />)}
            {spec.labels && last && series.length <= 4 && (
              <text className="tick" x={pts[pts.length - 1][0] + 6} y={pts[pts.length - 1][1] + 3.5} style={{ fontSize: 11, fill: "var(--ink-2)" }}>
                {fmtVal(stacked ? last.y - (last.y0 ?? 0) : last.y)}
              </text>
            )}
          </g>
        );
      })}

      {tip?.cx !== undefined && !isBar && <line className="crosshair" x1={tip.cx} x2={tip.cx} y1={M.top} y2={M.top + innerH} />}
      {tip?.cx !== undefined && isBar && (
        <rect x={tip.cx - band / 2} y={M.top} width={band} height={innerH} fill="var(--ink)" opacity={0.05} pointerEvents="none" />
      )}
      {tip?.marks?.map((m, i) => (
        <circle key={i} cx={m.x} cy={m.y} r={5} fill={m.color} stroke="var(--surface)" strokeWidth={2} pointerEvents="none" />
      ))}
      <HoverLayer M={M} innerW={innerW} innerH={innerH} onMove={onMove} onLeave={() => setTip(null)} />
    </svg>
  );
}

function HoverLayer({
  M,
  innerW,
  innerH,
  onMove,
  onLeave,
}: {
  M: { top: number; left: number };
  innerW: number;
  innerH: number;
  onMove: (e: React.MouseEvent<SVGRectElement>) => void;
  onLeave: () => void;
}) {
  return <rect x={M.left} y={M.top} width={innerW} height={innerH} fill="transparent" onMouseMove={onMove} onMouseLeave={onLeave} />;
}

function HBars({
  prepared,
  width,
  height,
  spec,
  setTip,
  colorOf,
}: {
  prepared: Prepared;
  width: number;
  height: number;
  spec: ChartSpec;
  setTip: (t: Tooltip | null) => void;
  colorOf: ColorOf;
}) {
  const { series, categories, stacked } = prepared;
  const labelW = Math.min(180, Math.max(...categories.map((c) => c.length), 4) * 6.6 + 14);
  const M = { top: 8, right: 40, bottom: 26, left: labelW };
  const rowH = Math.max(16, Math.min(34, (height - M.top - M.bottom) / Math.max(1, categories.length)));
  const H = M.top + M.bottom + rowH * categories.length;
  const innerW = Math.max(10, width - M.left - M.right);
  let max = 0;
  let min = 0;
  for (const s of series) for (const p of s.points) {
    if (p.y > max) max = p.y;
    if (p.y < min) min = p.y;
    if ((p.y0 ?? 0) < min) min = p.y0 ?? 0;
  }
  const ticks = niceTicks(min, max, Math.max(2, Math.floor(innerW / 90)));
  if (ticks.length) {
    min = Math.min(min, ticks[0]);
    max = Math.max(max, ticks[ticks.length - 1]);
  }
  const xSc = (v: number) => M.left + ((v - min) / (max - min || 1)) * innerW;
  const groupCount = stacked ? 1 : series.length;
  const barH = Math.max(2, Math.min(22, (rowH * 0.72) / groupCount - (groupCount > 1 ? 2 : 0)));
  const groupH = barH * groupCount + (groupCount - 1) * 2;
  return (
    <svg viewBox={`0 0 ${width} ${H}`} width={width} height={H} role="img">
      <g className="grid">
        {ticks.map((t) => (
          <line key={t} x1={xSc(t)} x2={xSc(t)} y1={M.top} y2={H - M.bottom} />
        ))}
      </g>
      <g className="axis">
        <line x1={xSc(0)} x2={xSc(0)} y1={M.top} y2={H - M.bottom} />
      </g>
      <g className="tick">
        {ticks.map((t) => (
          <text key={t} x={xSc(t)} y={H - M.bottom + 16} textAnchor="middle">
            {fmtVal(t)}{spec.normalize ? "%" : ""}
          </text>
        ))}
        {categories.map((c, i) => (
          <text key={c} x={M.left - 8} y={M.top + i * rowH + rowH / 2 + 3.5} textAnchor="end">
            {trunc(c, 26)}
          </text>
        ))}
      </g>
      {series.map((s, si) => (
        <g key={s.name}>
          {s.points.map((p, pi) => {
            const i = categories.indexOf(p.x as string);
            const y = M.top + i * rowH + rowH / 2 - groupH / 2 + (stacked ? 0 : si * (barH + 2));
            const x0 = xSc(p.y0 ?? 0);
            const x1 = xSc(p.y);
            const gap = stacked && p.y0 ? 2 : 0;
            const w = Math.max(0.5, Math.abs(x1 - x0) - gap);
            const val = stacked ? p.y - (p.y0 ?? 0) : p.y;
            return (
              <g key={pi}>
                <path
                  d={roundedHBar(Math.min(x0, x1) + gap, y, w, barH, p.y >= (p.y0 ?? 0) ? "right" : "left", 4)}
                  fill={colorOf(s)}
                  onMouseMove={(e) => {
                    const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                    setTip({ px: e.clientX - r.left, py: e.clientY - r.top, title: String(p.x), rows: [{ name: s.name, color: colorOf(s), value: fmtVal(val) + (spec.normalize ? "%" : "") }] });
                  }}
                  onMouseLeave={() => setTip(null)}
                />
                {spec.labels && !stacked && (
                  <text className="tick" x={Math.max(x0, x1) + 5} y={y + barH / 2 + 3.5} style={{ fontSize: 10.5, fill: "var(--ink-2)" }}>
                    {fmtVal(val)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      ))}
    </svg>
  );
}

function Pie({
  prepared,
  width,
  height,
  setTip,
  colorOf,
}: {
  prepared: Prepared;
  width: number;
  height: number;
  setTip: (t: Tooltip | null) => void;
  colorOf: ColorOf;
}) {
  const { series, categories } = prepared;
  // Slices are the categories of the first series (or the series themselves when coloured).
  const slices = series.length > 1
    ? series.map((s) => ({ name: s.name, slot: s.slot, value: s.points.reduce((a, p) => a + Math.abs(p.y - (p.y0 ?? 0)), 0) }))
    : (series[0]?.points ?? []).map((p, i) => ({ name: String(p.x), slot: i, value: Math.abs(p.y) }));
  const folded = slices.length > 8
    ? [...slices.slice(0, 7), { name: "Other", slot: 7, value: slices.slice(7).reduce((a, s) => a + s.value, 0) }]
    : slices;
  const total = folded.reduce((a, s) => a + s.value, 0) || 1;
  const R = Math.min(height, width * 0.5) / 2 - 10;
  const cx = Math.min(width / 2, R + 20);
  const cy = height / 2;
  let angle = -Math.PI / 2;
  const arcs = folded.map((s) => {
    const a0 = angle;
    const a1 = angle + (s.value / total) * Math.PI * 2;
    angle = a1;
    return { ...s, a0, a1, share: s.value / total };
  });
  const arcPath = (a0: number, a1: number, r: number, r0: number) => {
    const big = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a: number, rr: number) => `${cx + Math.cos(a) * rr},${cy + Math.sin(a) * rr}`;
    return `M${p(a0, r)} A${r},${r} 0 ${big} 1 ${p(a1, r)} L${p(a1, r0)} A${r0},${r0} 0 ${big} 0 ${p(a0, r0)} Z`;
  };
  void categories;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img">
      {arcs.map((a) => (
        <path
          key={a.name}
          d={arcPath(a.a0 + 0.008, a.a1 - 0.008, R, R * 0.55)}
          fill={colorOf(a)}
          onMouseMove={(e) => {
            const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
            setTip({ px: e.clientX - r.left, py: e.clientY - r.top, title: a.name, rows: [{ name: `${(a.share * 100).toFixed(1)}%`, color: colorOf(a), value: fmtVal(a.value) }] });
          }}
          onMouseLeave={() => setTip(null)}
        />
      ))}
      <text x={cx} y={cy - 4} textAnchor="middle" className="tick" style={{ fontSize: 18, fill: "var(--ink)", fontWeight: 600 }}>
        {fmtVal(total)}
      </text>
      <text x={cx} y={cy + 14} textAnchor="middle" className="tick">
        total
      </text>
      <g className="tick">
        {arcs.map((a, i) => (
          <g key={a.name} transform={`translate(${cx + R + 24},${cy - (arcs.length * 18) / 2 + i * 18 + 6})`}>
            <rect width="9" height="9" rx="2" y="-8" fill={colorOf(a)} />
            <text x="14" y="0" style={{ fill: "var(--ink-2)" }}>
              {trunc(a.name, 22)}
            </text>
            <text x={Math.min(width - cx - R - 40, 220)} y="0" textAnchor="end" style={{ fill: "var(--ink-3)" }}>
              {(a.share * 100).toFixed(1)}%
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

// ── helpers ───────────────────────────────────────────────────────────

export function fmtVal(v: number): string {
  return formatNumber(v);
}

function trunc(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function logTicks(min: number, max: number): number[] {
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
    const v = 10 ** e;
    if (v >= min && v <= max) out.push(v);
  }
  return out.length >= 2 ? out : niceTicks(min, max, 4);
}

/** Bar with a 4px radius on the data end only, square at the baseline. */
function roundedBar(x: number, y: number, w: number, h: number, end: "top" | "bottom", r: number): string {
  const rr = Math.min(r, w / 2, h);
  if (end === "top") {
    return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
  }
  return `M${x},${y} V${y + h - rr} Q${x},${y + h} ${x + rr},${y + h} H${x + w - rr} Q${x + w},${y + h} ${x + w},${y + h - rr} V${y} Z`;
}

function roundedHBar(x: number, y: number, w: number, h: number, end: "right" | "left", r: number): string {
  const rr = Math.min(r, h / 2, w);
  if (end === "right") {
    return `M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z`;
  }
  return `M${x + w},${y} H${x + rr} Q${x},${y} ${x},${y + rr} V${y + h - rr} Q${x},${y + h} ${x + rr},${y + h} H${x + w} Z`;
}
