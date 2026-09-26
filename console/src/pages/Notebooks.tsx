import { BookOpen, ChartBar, Code, Database, DotsThree, Plus, Trash } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, timeAgo } from "../api";
import { useCrumbs } from "../App";
import { makeCell } from "../components/notebook/cells";
import { Empty, Skeleton, useConfirm } from "../components/ui";
import type { Dataset, Notebook, NotebookCell } from "../types";

function starter(kind: "blank" | "explore" | "pipeline" | "report", datasets: Dataset[]): { name: string; cells: NotebookCell[] } {
  const table = datasets[0]?.name.replace(/-/g, "_") ?? "my_dataset";
  switch (kind) {
    case "explore":
      return {
        name: `Explore ${datasets[0]?.name ?? "data"}`,
        cells: [
          makeCell("markdown", "python", `# Explore ${datasets[0]?.name ?? "a dataset"}\n\nPreview the rows, profile the columns, then chart what stands out.`),
          { ...makeCell("sql", "python", `SELECT *\nFROM ${table}\nLIMIT 200`), name: "sample" },
          { ...makeCell("sql", "python", `SELECT COUNT(*) AS rows\nFROM ${table}`), name: "size" },
        ],
      };
    case "pipeline":
      return {
        name: "Pipeline prototype",
        cells: [
          makeCell("markdown", "python", "# Pipeline prototype\n\nEach cell is a task: the SQL cell is the source, the Python cell transforms it, the TypeScript cell scores it. Promote them to a workflow when they work."),
          { ...makeCell("sql", "python", `SELECT *\nFROM ${table}\nLIMIT 500`), name: "source" },
          { ...makeCell("code", "python", 'def handler(params, inputs):\n    rows = inputs["source"]\n    print(f"transforming {len(rows)} rows")\n    return [r for r in rows][:100]\n'), name: "clean" },
          makeCell("code", "typescript", 'export function handler(params: Record<string, unknown>, inputs: { clean: Record<string, unknown>[] }) {\n  return { rows: inputs.clean.length, first: inputs.clean[0] ?? null };\n}\n'),
        ],
      };
    case "report":
      return {
        name: "Weekly report",
        cells: [
          makeCell("markdown", "python", "# Weekly report\n\n## Headline numbers\n\nThe SQL cells below feed the charts. Hide their code with the eye icon for a clean read."),
          { ...makeCell("sql", "python", `SELECT *\nFROM ${table}\nLIMIT 1000`), name: "data", view: "chart", collapsed: true },
          makeCell("markdown", "python", "## Notes\n\n- What changed this week\n- What to watch next"),
        ],
      };
    default:
      return { name: "Untitled notebook", cells: [makeCell("markdown", "python", "# Untitled notebook\n\nStart with a heading. Add cells with the + between cells."), makeCell("code", "python")] };
  }
}

export default function Notebooks() {
  const [notebooks, setNotebooks] = useState<Notebook[] | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [menu, setMenu] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const navigate = useNavigate();
  useCrumbs([{ label: "Notebooks" }]);

  const refresh = useCallback(() => {
    api.get<Notebook[]>("/api/notebooks").then(setNotebooks).catch(() => setNotebooks([]));
    api.get<Dataset[]>("/api/datasets").then(setDatasets).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const create = async (kind: "blank" | "explore" | "pipeline" | "report") => {
    const nb = await api.post<Notebook>("/api/notebooks", starter(kind, datasets));
    navigate(`/notebooks/${nb.id}`);
  };

  const remove = async (nb: Notebook) => {
    setMenu(null);
    if (!(await confirm({ title: `Delete “${nb.name}”?`, body: "This removes the notebook and its outputs.", confirmLabel: "Delete notebook" }))) return;
    await api.delete(`/api/notebooks/${nb.id}`);
    refresh();
  };

  const duplicate = async (nb: Notebook) => {
    setMenu(null);
    const copy = await api.post<Notebook>("/api/notebooks", { name: `${nb.name} (copy)`, cells: (nb.cells ?? []).map((c) => ({ ...c, output: null })) });
    navigate(`/notebooks/${copy.id}`);
  };

  const preview = (nb: Notebook) => {
    const md = (nb.cells ?? []).find((c) => c.kind === "markdown");
    const text = md?.code.replace(/^#.*$/m, "").replace(/[#*`>]/g, "").trim();
    return text || (nb.cells ?? []).find((c) => c.kind !== "markdown")?.code.split("\n")[0] || "Empty notebook";
  };

  return (
    <div className="content">
      {confirmDialog}
      <div className="page-head">
        <div>
          <h1>Notebooks</h1>
          <p>Executable documents: SQL, Python, TypeScript, charts, and notes that run against the live platform.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => create("blank")}>
            <Plus size={14} weight="bold" /> New notebook
          </button>
        </div>
      </div>

      <div className="section" style={{ marginTop: 0, marginBottom: 20 }}>
        <div className="tpl-row">
          <button className="tpl" onClick={() => create("explore")}>
            <div className="t"><Database size={15} /> Explore a dataset</div>
            <div className="d">Preview, profile, and chart {datasets[0]?.name ?? "a dataset"}.</div>
          </button>
          <button className="tpl" onClick={() => create("pipeline")}>
            <div className="t"><Code size={15} /> Pipeline prototype</div>
            <div className="d">SQL source → Python transform → TypeScript scoring, chained by name.</div>
          </button>
          <button className="tpl" onClick={() => create("report")}>
            <div className="t"><ChartBar size={15} /> Report</div>
            <div className="d">Markdown narrative with code hidden and charts up front.</div>
          </button>
        </div>
      </div>

      {notebooks === null ? (
        <div className="nb-grid">
          {[0, 1, 2].map((i) => (
            <div className="nb-card" key={i}><Skeleton h={16} w="60%" /><Skeleton h={12} /><Skeleton h={12} w="80%" /></div>
          ))}
        </div>
      ) : notebooks.length === 0 ? (
        <div className="card">
          <Empty icon={<BookOpen size={20} />} title="No notebooks yet" hint="Create one to explore data and prototype tasks. Templates above give you a head start." />
        </div>
      ) : (
        <div className="nb-grid">
          {notebooks.map((nb) => {
            const cells = nb.cells ?? [];
            return (
              <div key={nb.id} className="nb-card" onClick={() => navigate(`/notebooks/${nb.id}`)}>
                <div className="t">{nb.name}</div>
                <div className="d">{preview(nb)}</div>
                <div className="foot">
                  <span className="kinds" title={`${cells.length} cells`}>
                    {cells.slice(0, 24).map((c) => <span key={c.id} className={c.kind} />)}
                  </span>
                  <span>{cells.length} cells</span>
                  <span className="grow" />
                  <span>{timeAgo(nb.updated_at)}</span>
                </div>
                <button
                  className="btn icon sm ghost menu-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu(menu === nb.id ? null : nb.id);
                  }}
                >
                  <DotsThree size={16} weight="bold" />
                </button>
                {menu === nb.id && (
                  <div className="menu" style={{ right: 10, top: 36 }} onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => duplicate(nb)}>Duplicate</button>
                    <button className="danger" onClick={() => remove(nb)}><Trash size={14} /> Delete</button>
                  </div>
                )}
              </div>
            );
          })}
          <div className="nb-card new" onClick={() => create("blank")}>
            <Plus size={20} />
            <span>New notebook</span>
          </div>
        </div>
      )}
    </div>
  );
}
