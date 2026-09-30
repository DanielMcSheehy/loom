// The "+" between cells. Opens an Observable-style picker: cell kinds up
// top, then searchable templates (dataset previews, charts, transforms).
import {
  ChartBar,
  Code,
  Database,
  FileText,
  FunnelSimple,
  MagnifyingGlass,
  Plugs,
  Plus,
  Table,
  TextAa,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Dataset, NotebookCell } from "../../types";
import { useClickOutside } from "../ui";
import { CODE_TEMPLATE, PLATFORM_TEMPLATE, TRANSFORM_TEMPLATE, makeCell } from "./cells";

interface Choice {
  id: string;
  title: string;
  desc: string;
  icon: ReactNode;
  iconCls: string;
  keywords: string;
  make: () => NotebookCell | NotebookCell[];
  primary?: boolean;
}

export default function CellInserter({
  onInsert,
  datasets,
  last,
  hasPrev,
}: {
  onInsert: (cells: NotebookCell | NotebookCell[]) => void;
  datasets: Dataset[];
  last?: boolean;
  hasPrev: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useClickOutside(ref, () => setOpen(false), open);
  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const choices = useMemo<Choice[]>(() => {
    const table = (name: string) => name.replace(/-/g, "_");
    const primary: Choice[] = [
      { id: "py", title: "Python", desc: "handler(params, inputs)", icon: <Code size={16} />, iconCls: "py", keywords: "python code", primary: true, make: () => makeCell("code", "python") },
      { id: "ts", title: "TypeScript", desc: "export function handler", icon: <Code size={16} />, iconCls: "ts", keywords: "typescript code", primary: true, make: () => makeCell("code", "typescript") },
      { id: "js", title: "JavaScript", desc: "export function handler", icon: <Code size={16} />, iconCls: "js", keywords: "javascript node code", primary: true, make: () => makeCell("code", "javascript") },
      { id: "sql", title: "SQL", desc: "Query datasets with Polars", icon: <Database size={16} />, iconCls: "sql", keywords: "sql query select polars", primary: true, make: () => makeCell("sql", "python", datasets[0] ? `SELECT *\nFROM ${table(datasets[0].name)}\nLIMIT 100` : "SELECT 1 AS one") },
      { id: "md", title: "Markdown", desc: "Headings, notes, links", icon: <TextAa size={16} />, iconCls: "md", keywords: "markdown text notes heading", primary: true, make: () => makeCell("markdown") },
      { id: "chart", title: "Chart", desc: "SQL cell opened in chart view", icon: <ChartBar size={16} />, iconCls: "chart", keywords: "chart plot graph bar line visualization", primary: true, make: () => ({ ...makeCell("sql", "python", datasets[0] ? `SELECT *\nFROM ${table(datasets[0].name)}\nLIMIT 500` : "SELECT 1 AS x, 2 AS y"), view: "chart" }) },
    ];
    const templates: Choice[] = [
      ...datasets.map<Choice>((d) => ({
        id: `ds-${d.name}`,
        title: `Preview ${d.name}`,
        desc: `${d.records.toLocaleString()} records · SELECT * LIMIT 100`,
        icon: <Table size={16} />,
        iconCls: "data",
        keywords: `dataset preview table ${d.name}`,
        make: () => makeCell("sql", "python", `SELECT *\nFROM ${table(d.name)}\nLIMIT 100`),
      })),
      ...datasets.map<Choice>((d) => ({
        id: `agg-${d.name}`,
        title: `Aggregate ${d.name}`,
        desc: "GROUP BY template with a chart",
        icon: <ChartBar size={16} />,
        iconCls: "chart",
        keywords: `aggregate group by chart ${d.name}`,
        make: () => ({ ...makeCell("sql", "python", `SELECT <column>, COUNT(*) AS n, AVG(<measure>) AS avg_value\nFROM ${table(d.name)}\nGROUP BY <column>\nORDER BY n DESC\nLIMIT 50`), view: "chart" }),
      })),
      ...(hasPrev
        ? [
            { id: "tf-py", title: "Transform previous output", desc: "Python over inputs.prev", icon: <FunnelSimple size={16} />, iconCls: "py", keywords: "transform filter map python prev", make: () => makeCell("code", "python", TRANSFORM_TEMPLATE.python) },
            { id: "tf-ts", title: "Transform previous output", desc: "TypeScript over inputs.prev", icon: <FunnelSimple size={16} />, iconCls: "ts", keywords: "transform filter map typescript prev", make: () => makeCell("code", "typescript", TRANSFORM_TEMPLATE.typescript) },
          ]
        : []),
      { id: "loom-py", title: "Use the platform from Python", desc: "loom.query / ingest / invoke", icon: <Plugs size={16} />, iconCls: "py", keywords: "loom bindings query ingest invoke python api", make: () => makeCell("code", "python", PLATFORM_TEMPLATE.python) },
      { id: "loom-ts", title: "Use the platform from TypeScript", desc: "loom.query / ingest / invoke", icon: <Plugs size={16} />, iconCls: "ts", keywords: "loom bindings query ingest invoke typescript api", make: () => makeCell("code", "typescript", PLATFORM_TEMPLATE.typescript) },
      { id: "section", title: "Section heading", desc: "Markdown H2 + paragraph", icon: <FileText size={16} />, iconCls: "md", keywords: "section heading title markdown", make: () => makeCell("markdown", "python", "## Section\n\nWhat this part of the analysis shows.") },
      { id: "starter", title: "Starter: SQL → Python → chart", desc: "Three chained cells", icon: <Code size={16} />, iconCls: "chart", keywords: "starter example chain pipeline", make: () => [
        { ...makeCell("sql", "python", datasets[0] ? `SELECT *\nFROM ${table(datasets[0].name)}\nLIMIT 500` : "SELECT 1 AS x, 2 AS y"), name: "source" },
        makeCell("code", "python", 'def handler(params, inputs):\n    rows = inputs["source"]\n    print(f"{len(rows)} rows from the SQL cell")\n    return rows[:20]\n'),
      ] },
    ];
    void CODE_TEMPLATE;
    return [...primary, ...templates];
  }, [datasets, hasPrev]);

  const needle = q.trim().toLowerCase();
  const filtered = needle ? choices.filter((c) => `${c.title} ${c.desc} ${c.keywords}`.toLowerCase().includes(needle)) : choices;
  const primaries = needle ? [] : filtered.filter((c) => c.primary);
  const rest = needle ? filtered : filtered.filter((c) => !c.primary);
  const flat = [...primaries, ...rest];

  useEffect(() => setSel(0), [q]);

  const pick = (c: Choice) => {
    onInsert(c.make());
    setOpen(false);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(flat.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flat[sel]) pick(flat[sel]);
    }
  };

  return (
    <div className={`inserter${open ? " open" : ""}${last ? " last" : ""}`} ref={ref}>
      {/* .plus-col spans the cell column only (the gutter is column 1), so the
          "+" and the picker are centred on the cells, not on the whole row. */}
      <div className="plus-col">
        <button className="plus" title="Insert cell" onClick={() => setOpen((o) => !o)} aria-label="Insert cell">
          <Plus size={13} weight="bold" />
        </button>
        {last && !open && (
          <button className="btn sm ghost add-label" style={{ color: "var(--ink-3)" }} onClick={() => setOpen(true)}>
            Add cell
          </button>
        )}
        {open && (
          <div className="picker" onKeyDown={onKey}>
            <div className="palette-input">
              <MagnifyingGlass size={16} />
              <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a cell: Python, SQL, chart, dataset…" />
              <span className="kbd">esc</span>
            </div>
            {primaries.length > 0 && (
              <div className="picker-grid">
                {primaries.map((c, i) => (
                  <button key={c.id} className={`picker-item${sel === i ? " sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => pick(c)}>
                    <span className={`ico ${c.iconCls}`}>{c.icon}</span>
                    <span>
                      <span className="t">{c.title}</span>
                      <span className="d">{c.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="picker-list">
              {!needle && <div className="palette-group">Templates</div>}
              {rest.length === 0 && <div className="empty" style={{ padding: 16 }}>No matches</div>}
              {rest.map((c, j) => {
                const i = primaries.length + j;
                return (
                  <div key={c.id} className={`palette-item${sel === i ? " sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => pick(c)}>
                    <span className={`ico ${c.iconCls}`} style={{ background: "var(--surface-2)" }}>
                      {c.icon}
                    </span>
                    <div>
                      <div className="t">{c.title}</div>
                      <div className="d">{c.desc}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="palette-foot">
              <span><span className="kbd">↑↓</span> choose</span>
              <span><span className="kbd">↵</span> insert</span>
              <span>type to search templates and datasets</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
