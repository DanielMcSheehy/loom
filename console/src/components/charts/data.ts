// Column inference and series preparation shared by the chart, chart
// builder, and data grid. Works on plain arrays of row objects.

export type Row = Record<string, unknown>;
export type ColType = "number" | "date" | "boolean" | "string" | "object" | "null";

export interface ColumnInfo {
  name: string;
  type: ColType;
  nulls: number;
  distinct: number;
  min?: number;
  max?: number;
  mean?: number;
  /** For numbers: 14-bin histogram counts; for strings: top-5 values. */
  hist?: number[];
  top?: Array<{ value: string; count: number }>;
  trueRatio?: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function isDateLike(v: unknown): boolean {
  return typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v));
}

export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toTime(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    // Date-only values are calendar days: local midnight, not UTC.
    const m = v.match(DATE_ONLY);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (isDateLike(v)) return Date.parse(v);
  }
  return null;
}

export function typeOf(v: unknown): ColType {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return isDateLike(v) ? "date" : "string";
  return "object";
}

/** Infer column types + light summary stats from a sample of rows. */
export function inferColumns(rows: Row[], sampleLimit = 5000): ColumnInfo[] {
  if (rows.length === 0) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(0, 50)) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        names.push(k);
      }
    }
  }
  const sample = rows.length > sampleLimit ? rows.slice(0, sampleLimit) : rows;
  return names.map((name) => {
    const counts: Record<ColType, number> = { number: 0, date: 0, boolean: 0, string: 0, object: 0, null: 0 };
    const nums: number[] = [];
    const valueCounts = new Map<string, number>();
    let trues = 0;
    for (const r of sample) {
      const v = r[name];
      const t = typeOf(v);
      counts[t]++;
      if (t === "number") nums.push(v as number);
      else if (t === "date") nums.push(Date.parse(v as string));
      else if (t === "boolean" && v) trues++;
      if (t !== "null" && t !== "object") {
        const key = String(v);
        valueCounts.set(key, (valueCounts.get(key) ?? 0) + 1);
      }
    }
    const nonNull = sample.length - counts.null;
    let type: ColType = "null";
    if (nonNull > 0) {
      const ranked = (Object.keys(counts) as ColType[]).filter((t) => t !== "null").sort((a, b) => counts[b] - counts[a]);
      type = ranked[0];
      // Mixed numeric strings and numbers collapse to number when numbers dominate.
      if (type === "string" && counts.number > 0 && counts.number >= counts.string) type = "number";
    }
    const info: ColumnInfo = { name, type, nulls: counts.null, distinct: valueCounts.size };
    if ((type === "number" || type === "date") && nums.length) {
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      for (const n of nums) {
        if (n < min) min = n;
        if (n > max) max = n;
        sum += n;
      }
      info.min = min;
      info.max = max;
      info.mean = sum / nums.length;
      const bins = 14;
      const hist = new Array(bins).fill(0);
      const span = max - min || 1;
      for (const n of nums) hist[Math.min(bins - 1, Math.floor(((n - min) / span) * bins))]++;
      info.hist = hist;
    }
    if (type === "string" || type === "boolean") {
      info.top = [...valueCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([value, count]) => ({ value, count }));
    }
    if (type === "boolean") info.trueRatio = nonNull ? trues / nonNull : 0;
    return info;
  });
}

// ── chart spec & series preparation ──────────────────────────────────

export type Mark = "bar" | "hbar" | "line" | "area" | "scatter" | "pie" | "histogram" | "radar";
export type Agg = "none" | "sum" | "avg" | "count" | "min" | "max" | "median";
/** Statistic lines drawn for line/area marks when x has duplicate values. */
export type Stat = "avg" | "min" | "max" | "median";
export const STATS: Stat[] = ["avg", "min", "max", "median"];

export interface ChartSpec {
  mark: Mark;
  x: string;
  y: string[];
  color?: string;
  agg?: Agg;
  stack?: boolean;
  normalize?: boolean;
  sort?: "none" | "x" | "y-desc" | "y-asc";
  limit?: number;
  logY?: boolean;
  bins?: number;
  labels?: boolean;
  title?: string;
  /**
   * Line/area only: draw one line per statistic of the same y (per x
   * bucket) instead of a single aggregated line. Empty/undefined keeps the
   * classic single line (`agg`).
   */
  stats?: Stat[];
  /** With `stats`: also shade the min–max envelope of each measure. */
  band?: boolean;
  /**
   * Radar only. "x" (default): each distinct x value is an axis and each y
   * measure (or colour group) a polygon. "measures": each y column is an
   * axis and each x value a polygon (x is the series label).
   */
  radarAxes?: "x" | "measures";
  /**
   * Per-series colour overrides keyed by series / slice name. Values are
   * any CSS colour: a palette token (`var(--s3)`) stays theme-aware, a hex
   * is used verbatim.
   */
  colors?: Record<string, string>;
}

export interface Series {
  name: string;
  /** index into the categorical palette (0..7) */
  slot: number;
  /** "band": a shaded envelope from y0 (min) to y (max), no line. */
  kind?: "line" | "band";
  points: Array<{ x: number | string; y: number; y0?: number; raw?: Row; label?: string }>;
}

export interface Prepared {
  series: Series[];
  xType: "band" | "linear" | "time";
  categories: string[];
  /** sum of |y| per category (for pie shares and normalize) */
  totals: Map<string, number>;
  stacked: boolean;
}

const MAX_SERIES = 8;

function aggregate(values: number[], agg: Agg): number {
  if (values.length === 0) return 0;
  switch (agg) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "count":
      return values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "median": {
      const s = [...values].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    default:
      return values[values.length - 1];
  }
}

export function prepare(rows: Row[], spec: ChartSpec, columns?: ColumnInfo[]): Prepared {
  // Radar with measures as axes: pivot to long form (axis = measure name,
  // series = x value) and render as the plain x-as-axes case.
  if (spec.mark === "radar" && spec.radarAxes === "measures" && spec.y.length > 1 && !spec.color) {
    const long: Row[] = [];
    for (const r of rows) {
      const label = r[spec.x];
      if (label === null || label === undefined) continue;
      for (const m of spec.y) {
        const v = toNumber(r[m]);
        if (v === null) continue;
        long.push({ __axis: m, __series: String(label), __value: v });
      }
    }
    return prepare(long, { ...spec, radarAxes: "x", x: "__axis", y: ["__value"], color: "__series", sort: "none", limit: undefined });
  }
  const cols = columns ?? inferColumns(rows);
  const xInfo = cols.find((c) => c.name === spec.x);
  const isBandMark = spec.mark === "bar" || spec.mark === "hbar" || spec.mark === "pie" || spec.mark === "radar";
  const agg: Agg = spec.agg ?? "none";
  const stats = (spec.mark === "line" || spec.mark === "area") && spec.stats?.length ? spec.stats : null;

  // Histogram: bin the x column.
  if (spec.mark === "histogram") {
    const nums = rows.map((r) => toNumber(r[spec.x])).filter((n): n is number => n !== null);
    if (nums.length === 0) return { series: [], xType: "band", categories: [], totals: new Map(), stacked: false };
    const bins = Math.max(2, Math.min(80, spec.bins ?? 20));
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const span = max - min || 1;
    const counts = new Array(bins).fill(0);
    for (const n of nums) counts[Math.min(bins - 1, Math.floor(((n - min) / span) * bins))]++;
    const width = span / bins;
    const categories = counts.map((_, i) => formatBinLabel(min + i * width, min + (i + 1) * width));
    return {
      series: [{ name: spec.x, slot: 0, points: counts.map((c, i) => ({ x: categories[i], y: c })) }],
      xType: "band",
      categories,
      totals: new Map(categories.map((c, i) => [c, counts[i]])),
      stacked: false,
    };
  }

  let xType: Prepared["xType"] = "band";
  if (!isBandMark && xInfo) {
    if (xInfo.type === "date") xType = "time";
    else if (xInfo.type === "number") xType = "linear";
  }
  const xKey = (r: Row): string | number | null => {
    const v = r[spec.x];
    if (v === null || v === undefined) return null;
    if (xType === "time") return toTime(v);
    if (xType === "linear") return toNumber(v);
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  };

  // Split into series: by color column, else one series per y measure.
  const measures = spec.y.length ? spec.y : [];
  type Bucket = Map<string, Map<string | number, { vals: number[]; raw?: Row }>>;
  const buckets: Bucket = new Map();
  const order: string[] = [];
  const addVal = (sname: string, x: string | number, y: number, raw: Row) => {
    let m = buckets.get(sname);
    if (!m) {
      m = new Map();
      buckets.set(sname, m);
      order.push(sname);
    }
    const slot = m.get(x) ?? { vals: [], raw };
    slot.vals.push(y);
    m.set(x, slot);
  };
  for (const r of rows) {
    const x = xKey(r);
    if (x === null || (typeof x === "number" && !Number.isFinite(x))) continue;
    if (spec.color) {
      const cv = r[spec.color];
      const sname = cv === null || cv === undefined ? "null" : String(cv);
      const y = agg === "count" ? 1 : toNumber(r[measures[0]]);
      if (y === null) continue;
      addVal(sname, x, y, r);
    } else {
      for (const mname of measures.length ? measures : ["__count"]) {
        const y = agg === "count" || mname === "__count" ? 1 : toNumber(r[mname]);
        if (y === null) continue;
        addVal(mname === "__count" ? "count" : mname, x, y, r);
      }
    }
  }

  // Fold overflow series (by total magnitude) into "Other".
  let names = order;
  if (names.length > MAX_SERIES) {
    const totalsBy = names.map((n) => ({
      n,
      t: [...buckets.get(n)!.values()].reduce((a, b) => a + Math.abs(aggregate(b.vals, agg)), 0),
    }));
    totalsBy.sort((a, b) => b.t - a.t);
    const keep = totalsBy.slice(0, MAX_SERIES - 1).map((t) => t.n);
    const other = new Map<string | number, { vals: number[]; raw?: Row }>();
    for (const n of names) {
      if (keep.includes(n)) continue;
      for (const [x, b] of buckets.get(n)!) {
        const o = other.get(x) ?? { vals: [] };
        o.vals.push(aggregate(b.vals, agg === "none" ? "sum" : agg));
        other.set(x, o);
      }
    }
    for (const [x, o] of other) o.vals = [aggregate(o.vals, "sum")];
    buckets.set("Other", other);
    names = [...keep, "Other"];
  }

  // Category ordering & limit (band axis).
  const catTotals = new Map<string, number>();
  const xValues = new Map<string | number, number>();
  for (const n of names) {
    for (const [x, b] of buckets.get(n)!) {
      const v = aggregate(b.vals, agg === "none" && xType === "band" ? "sum" : agg);
      const k = String(x);
      catTotals.set(k, (catTotals.get(k) ?? 0) + Math.abs(v));
      if (!xValues.has(x)) xValues.set(x, typeof x === "number" ? x : xValues.size);
    }
  }
  let categories = [...xValues.keys()].map(String);
  const sort = spec.sort ?? (xType === "band" ? "none" : "x");
  if (xType === "band") {
    if (sort === "y-desc") categories.sort((a, b) => (catTotals.get(b) ?? 0) - (catTotals.get(a) ?? 0));
    else if (sort === "y-asc") categories.sort((a, b) => (catTotals.get(a) ?? 0) - (catTotals.get(b) ?? 0));
    else if (sort === "x") categories.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (spec.limit && categories.length > spec.limit) categories = categories.slice(0, spec.limit);
  }
  const catSet = new Set(categories);

  if (stats) {
    // Statistic lines: one series per (measure × stat), plus an optional
    // min–max band per measure. Names stay short for a single measure.
    const series: Series[] = [];
    const label = (name: string, stat: string) => (names.length > 1 ? `${name} · ${stat}` : stat);
    for (const name of names) {
      const m = buckets.get(name)!;
      const entries = [...m.entries()].filter(([x]) => xType !== "band" || catSet.has(String(x)));
      const sortPts = <P extends { x: number | string }>(pts: P[]) =>
        xType !== "band"
          ? pts.sort((a, b) => (a.x as number) - (b.x as number))
          : pts.sort((a, b) => categories.indexOf(a.x as string) - categories.indexOf(b.x as string));
      if (spec.band) {
        series.push({
          name: label(name, "range"),
          slot: series.length % MAX_SERIES,
          kind: "band",
          points: sortPts(
            entries.map(([x, b]) => ({
              x: xType === "band" ? String(x) : (x as number),
              y0: aggregate(b.vals, "min"),
              y: aggregate(b.vals, "max"),
              raw: b.raw,
            })),
          ),
        });
      }
      for (const stat of stats) {
        series.push({
          name: label(name, stat),
          slot: series.length % MAX_SERIES,
          points: sortPts(entries.map(([x, b]) => ({ x: xType === "band" ? String(x) : (x as number), y: aggregate(b.vals, stat), raw: b.raw }))),
        });
      }
    }
    return { series, xType, categories, totals: catTotals, stacked: false };
  }

  const series: Series[] = names.map((name, i) => {
    const m = buckets.get(name)!;
    let pts = [...m.entries()]
      .filter(([x]) => xType !== "band" || catSet.has(String(x)))
      .map(([x, b]) => ({
        x: xType === "band" ? String(x) : (x as number),
        y: aggregate(b.vals, agg === "none" && xType === "band" && b.vals.length > 1 ? "sum" : agg),
        raw: b.raw,
      }));
    if (xType !== "band") pts.sort((a, b) => (a.x as number) - (b.x as number));
    else pts.sort((a, b) => categories.indexOf(a.x as string) - categories.indexOf(b.x as string));
    if (spec.normalize && xType === "band") {
      pts = pts.map((p) => ({ ...p, y: (p.y / (catTotals.get(p.x as string) || 1)) * 100 }));
    }
    return { name, slot: i % MAX_SERIES, points: pts };
  });

  const stacked = !!spec.stack && series.length > 1 && (spec.mark === "bar" || spec.mark === "hbar" || spec.mark === "area");
  if (stacked) {
    const pos = new Map<string | number, number>();
    const neg = new Map<string | number, number>();
    for (const s of series) {
      for (const p of s.points) {
        const acc = p.y >= 0 ? pos : neg;
        const base = acc.get(p.x) ?? 0;
        p.y0 = base;
        p.y = base + p.y;
        acc.set(p.x, p.y);
      }
    }
  }
  return { series, xType, categories, totals: catTotals, stacked };
}

function formatBinLabel(a: number, b: number): string {
  const f = (n: number) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : Number(n.toPrecision(3)).toString());
  return `${f(a)}–${f(b)}`;
}

/** Suggest a sensible default chart for a result set. */
export function suggestSpec(cols: ColumnInfo[], rows: Row[]): ChartSpec | null {
  const numeric = cols.filter((c) => c.type === "number");
  const temporal = cols.find((c) => c.type === "date");
  const categorical = cols.filter((c) => c.type === "string" && c.distinct > 1 && c.distinct <= Math.max(50, rows.length / 2));
  if (numeric.length === 0) return null;
  if (temporal) {
    return { mark: "line", x: temporal.name, y: [numeric[0].name], agg: rows.length > 500 ? "sum" : "none" };
  }
  const ordered = numeric.find((c) => c.name === "t" || /^(step|i|index|n|day|hour|time|x)$/i.test(c.name));
  if (ordered && numeric.length > 1) {
    return { mark: "line", x: ordered.name, y: [numeric.find((c) => c !== ordered)!.name] };
  }
  if (categorical.length) {
    const measure = numeric.find((c) => c.name !== categorical[0].name) ?? numeric[0];
    return { mark: "bar", x: categorical[0].name, y: [measure.name], agg: rows.length > categorical[0].distinct ? "sum" : "none", sort: "y-desc", limit: 30 };
  }
  if (numeric.length >= 2) return { mark: "scatter", x: numeric[0].name, y: [numeric[1].name] };
  return { mark: "histogram", x: numeric[0].name, y: [], bins: 20 };
}

// ── scales ───────────────────────────────────────────────────────────

export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    if (min === 0) return [0, 1];
    min = min - Math.abs(min) * 0.5;
    max = max + Math.abs(max) * 0.5;
  }
  const span = max - min;
  const rawStep = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

export function timeTicks(min: number, max: number, count = 6): Array<{ v: number; label: string }> {
  const span = max - min;
  if (span <= 0) return [{ v: min, label: fmtTime(min, span) }];
  const steps = [
    1000, 5000, 15000, 30000, 60000, 300000, 900000, 1800000, 3600000, 3 * 3600000, 6 * 3600000, 12 * 3600000,
    86400000, 2 * 86400000, 7 * 86400000, 14 * 86400000, 30 * 86400000, 90 * 86400000, 365 * 86400000,
  ];
  const step = steps.find((s) => span / s <= count) ?? steps[steps.length - 1] * Math.ceil(span / (steps[steps.length - 1] * count));
  const start = Math.ceil(min / step) * step;
  const out: Array<{ v: number; label: string }> = [];
  for (let v = start; v <= max; v += step) out.push({ v, label: fmtTime(v, span) });
  return out;
}

export function fmtTime(t: number, span: number): string {
  const d = new Date(t);
  if (span < 2 * 86400000) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (span < 400 * 86400000) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

export function fmtTimeFull(t: number): string {
  const d = new Date(t);
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return d.toLocaleString();
}
