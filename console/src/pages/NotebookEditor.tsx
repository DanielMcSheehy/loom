// Notebook editor. Cells are client-owned JSON persisted (with outputs)
// through PUT /api/notebooks/{id}. Execution: /api/execute for code cells
// (inputs = outputs of cells above), /api/query for SQL. Named cells feed
// cells below as inputs[name]; when a cell runs, cells that read from it
// re-run automatically (reactive mode), like Observable's dataflow.
import {
  ArrowsClockwise,
  Broom,
  DotsThree,
  DownloadSimple,
  Lightning,
  Play,
  Trash,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, download, timeAgo } from "../api";
import { useCrumbs } from "../App";
import { headings } from "../components/Markdown";
import Cell from "../components/notebook/Cell";
import CellInserter from "../components/notebook/CellInserter";
import {
  cellInputs,
  dependencies,
  dependents,
  exportMarkdown,
  fingerprint,
  isStale,
  newCellId,
} from "../components/notebook/cells";
import { useClickOutside, useConfirm, useToast } from "../components/ui";
import type { CellOutput, Connector, Dataset, Notebook, NotebookCell } from "../types";

const SQL_LIMIT = 5000;

export default function NotebookEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [cells, _setCells] = useState<NotebookCell[]>([]);
  const cellsRef = useRef<NotebookCell[]>([]);
  const [name, setName] = useState("");
  const nameRef = useRef("");
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [reactive, setReactive] = useState(() => localStorage.getItem("loom.nb.reactive") !== "off");
  const [menuOpen, setMenuOpen] = useState(false);
  const [drag, setDrag] = useState<{ id: string; over: string | null; pos: "before" | "after" } | null>(null);
  const dragRef = useRef<typeof drag>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const queue = useRef<string[]>([]);
  const pumping = useRef(false);
  useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);

  useCrumbs([{ label: "Notebooks", to: "/notebooks" }, { label: name || "Untitled" }]);

  useEffect(() => {
    if (!id) return;
    api.get<Notebook>(`/api/notebooks/${id}`).then((nb) => {
      setNotebook(nb);
      setName(nb.name);
      nameRef.current = nb.name;
      const cs = Array.isArray(nb.cells) ? nb.cells : [];
      cellsRef.current = cs;
      _setCells(cs);
      if (cs.length === 0) setEditing(new Set());
    });
    api.get<Connector[]>("/api/connectors").then(setConnectors).catch(() => {});
    api.get<Dataset[]>("/api/datasets").then(setDatasets).catch(() => {});
  }, [id]);

  useEffect(() => localStorage.setItem("loom.nb.reactive", reactive ? "on" : "off"), [reactive]);

  // ── persistence ─────────────────────────────────────────────────────
  const persist = useCallback(async () => {
    clearTimeout(saveTimer.current);
    setSaveState("saving");
    try {
      await api.put(`/api/notebooks/${id}`, { name: nameRef.current, cells: cellsRef.current });
      setSaveState("saved");
    } catch (e) {
      setSaveState("error");
      toast(`Save failed: ${(e as Error).message}`, "error");
    }
  }, [id, toast]);

  const scheduleSave = useCallback(() => {
    setSaveState("dirty");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(persist, 700);
  }, [persist]);

  const setCells = useCallback(
    (updater: NotebookCell[] | ((prev: NotebookCell[]) => NotebookCell[])) => {
      const next = typeof updater === "function" ? updater(cellsRef.current) : updater;
      cellsRef.current = next;
      _setCells(next);
      scheduleSave();
    },
    [scheduleSave],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        persist();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [persist]);

  // ── cell edits ──────────────────────────────────────────────────────
  const patchCell = useCallback(
    (cellId: string, patch: Partial<NotebookCell>) => setCells((cs) => cs.map((c) => (c.id === cellId ? { ...c, ...patch } : c))),
    [setCells],
  );

  const insertAt = (idx: number, incoming: NotebookCell | NotebookCell[]) => {
    const list = Array.isArray(incoming) ? incoming : [incoming];
    setCells((cs) => [...cs.slice(0, idx), ...list, ...cs.slice(idx)]);
    setEditing((prev) => {
      const n = new Set(prev);
      for (const c of list) if (c.kind === "markdown") n.add(c.id);
      return n;
    });
    setFocused(list[0].id);
    setTimeout(() => document.getElementById(`cell-${list[0].id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  const removeCell = async (cellId: string) => {
    const c = cellsRef.current.find((x) => x.id === cellId);
    if (c && c.code.trim().length > 40 && !(await confirm({ title: "Delete this cell?", body: "Its code and output will be removed.", confirmLabel: "Delete cell" }))) return;
    setCells((cs) => cs.filter((x) => x.id !== cellId));
  };

  const moveCell = (cellId: string, dir: -1 | 1) => {
    setCells((cs) => {
      const idx = cs.findIndex((c) => c.id === cellId);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= cs.length) return cs;
      const next = [...cs];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const duplicateCell = (cellId: string) => {
    setCells((cs) => {
      const idx = cs.findIndex((c) => c.id === cellId);
      const copy: NotebookCell = { ...cs[idx], id: newCellId(), name: undefined, output: null };
      return [...cs.slice(0, idx + 1), copy, ...cs.slice(idx + 1)];
    });
  };

  const moveTo = (cellId: string, targetId: string, pos: "before" | "after") => {
    setCells((cs) => {
      const from = cs.findIndex((c) => c.id === cellId);
      if (from < 0) return cs;
      const item = cs[from];
      const without = cs.filter((c) => c.id !== cellId);
      let to = without.findIndex((c) => c.id === targetId);
      if (to < 0) return cs;
      if (pos === "after") to += 1;
      return [...without.slice(0, to), item, ...without.slice(to)];
    });
  };

  /** Pointer-driven reorder: grab the handle, hover a cell, release. */
  const startDrag = (cellId: string, e: React.PointerEvent) => {
    e.preventDefault();
    const set = (d: typeof drag) => {
      dragRef.current = d;
      setDrag(d);
    };
    set({ id: cellId, over: null, pos: "after" });
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
    const onMove = (ev: PointerEvent) => {
      const els = Array.from(document.querySelectorAll<HTMLElement>("[data-cell-id]"));
      let best: { id: string; pos: "before" | "after" } | null = null;
      let bestD = Infinity;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const d = ev.clientY < r.top ? r.top - ev.clientY : ev.clientY > r.bottom ? ev.clientY - r.bottom : 0;
        if (d < bestD) {
          bestD = d;
          best = { id: el.dataset.cellId!, pos: ev.clientY < mid ? "before" : "after" };
        }
      }
      const cur = dragRef.current;
      if (cur && best && (cur.over !== best.id || cur.pos !== best.pos)) set({ ...cur, over: best.id, pos: best.pos });
    };
    const onUp = () => {
      const cur = dragRef.current;
      if (cur?.over && cur.over !== cur.id) moveTo(cur.id, cur.over, cur.pos);
      set(null);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── execution ───────────────────────────────────────────────────────
  const execute = async (cell: NotebookCell, prior: NotebookCell[]): Promise<CellOutput> => {
    const ran_at = new Date().toISOString();
    try {
      if (cell.kind === "sql") {
        const res = await api.post<{ rows: Array<Record<string, unknown>>; row_count: number; truncated: boolean; elapsed_ms: number }>("/api/query", {
          sql: cell.code,
          limit: SQL_LIMIT,
          connector: cell.connector || undefined,
        });
        return { ok: true, rows: res.rows, row_count: res.row_count, truncated: res.truncated, elapsed_ms: res.elapsed_ms, ran_at, fingerprint: fingerprint(cell.code, null, cell.connector ?? "") };
      }
      const inputs = cellInputs(prior);
      const res = await api.post<CellOutput & { duration_ms: number }>("/api/execute", {
        runtime: cell.runtime ?? "python",
        code: cell.code,
        inputs,
      });
      const fp = fingerprint(cell.code, inputs);
      return res.ok
        ? { ok: true, result: res.result, logs: res.logs, elapsed_ms: res.duration_ms, ran_at, fingerprint: fp }
        : { ok: false, error: res.error, trace: res.trace, logs: res.logs, elapsed_ms: res.duration_ms, ran_at, fingerprint: fp };
    } catch (e) {
      return { ok: false, error: (e as Error).message, ran_at };
    }
  };

  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      while (queue.current.length) {
        const cellId = queue.current.shift()!;
        setQueued((q) => {
          const n = new Set(q);
          n.delete(cellId);
          return n;
        });
        const cs = cellsRef.current;
        const idx = cs.findIndex((c) => c.id === cellId);
        if (idx < 0 || cs[idx].kind === "markdown") continue;
        setRunning((r) => new Set(r).add(cellId));
        const output = await execute(cs[idx], cs.slice(0, idx));
        setRunning((r) => {
          const n = new Set(r);
          n.delete(cellId);
          return n;
        });
        // Re-read: the user may have edited other cells meanwhile.
        const now = cellsRef.current;
        const at = now.findIndex((c) => c.id === cellId);
        if (at < 0) continue;
        setCells(now.map((c, i) => (i === at ? { ...c, output } : c)));
        if (output.ok && reactive) {
          const latest = cellsRef.current;
          for (const di of dependents(latest, at)) {
            const did = latest[di].id;
            if (!queue.current.includes(did)) {
              queue.current.push(did);
              setQueued((q) => new Set(q).add(did));
            }
          }
          // keep document order
          queue.current.sort((a, b) => latest.findIndex((c) => c.id === a) - latest.findIndex((c) => c.id === b));
        }
      }
    } finally {
      pumping.current = false;
    }
  }, [reactive, setCells]);

  const enqueue = useCallback(
    (ids: string[]) => {
      for (const cid of ids) if (!queue.current.includes(cid)) queue.current.push(cid);
      setQueued(new Set(queue.current));
      void pump();
    },
    [pump],
  );

  const runCell = useCallback((cellId: string) => enqueue([cellId]), [enqueue]);
  const runAll = () => enqueue(cellsRef.current.filter((c) => c.kind !== "markdown").map((c) => c.id));
  const runStale = () => enqueue(cellsRef.current.filter((c, i) => c.kind !== "markdown" && (isStale(cellsRef.current, i) || !c.output)).map((c) => c.id));

  const runAdvance = (cellId: string) => {
    runCell(cellId);
    const cs = cellsRef.current;
    const idx = cs.findIndex((c) => c.id === cellId);
    const next = cs[idx + 1];
    if (next) {
      setFocused(next.id);
      document.getElementById(`cell-${next.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      setFocused(null);
    }
  };

  const clearOutputs = () => setCells((cs) => cs.map((c) => ({ ...c, output: null })));

  const deleteNotebook = async () => {
    setMenuOpen(false);
    if (!(await confirm({ title: `Delete “${name}”?`, body: "The notebook and all its cells will be removed permanently.", confirmLabel: "Delete notebook" }))) return;
    await api.delete(`/api/notebooks/${id}`);
    navigate("/notebooks");
  };

  // ── derived ─────────────────────────────────────────────────────────
  const depsByCell = useMemo(() => {
    const byId = new Map(cells.map((c) => [c.id, c]));
    return cells.map((_, i) =>
      dependencies(cells, i).map((d) => {
        const c = byId.get(d)!;
        return { id: d, label: c.name?.trim() || `cell ${cells.indexOf(c) + 1}` };
      }),
    );
  }, [cells]);
  const staleByCell = useMemo(() => cells.map((_, i) => isStale(cells, i)), [cells]);
  const outline = useMemo(() => {
    const items: Array<{ id: string; text: string; level: number; kind: "h" | "cell" }> = [];
    for (const c of cells) {
      if (c.kind === "markdown") for (const h of headings(c.code)) items.push({ id: `cell-${c.id}`, text: h.text, level: h.level, kind: "h" });
      else if (c.name) items.push({ id: `cell-${c.id}`, text: c.name, level: 3, kind: "cell" });
    }
    return items;
  }, [cells]);
  const counts = useMemo(() => {
    const n = { code: 0, sql: 0, markdown: 0, errors: 0 };
    for (const c of cells) {
      n[c.kind]++;
      if (c.output && !c.output.ok) n.errors++;
    }
    return n;
  }, [cells]);

  if (!notebook) {
    return (
      <div className="content reading">
        <div className="skeleton" style={{ height: 34, width: 320, marginBottom: 20 }} />
        <div className="skeleton" style={{ height: 120, marginBottom: 12 }} />
        <div className="skeleton" style={{ height: 180 }} />
      </div>
    );
  }

  return (
    <div className="content reading">
      {confirmDialog}
      <div className="nb-head">
        <input
          className="nb-title"
          value={name}
          placeholder="Untitled notebook"
          onChange={(e) => {
            setName(e.target.value);
            nameRef.current = e.target.value;
            scheduleSave();
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </div>
      <div className="nb-head" style={{ marginBottom: 14 }}>
        <div className="meta">
          <span className={`save-state${saveState === "dirty" ? " dirty" : ""}`}>
            {saveState === "saved" ? `Saved · edited ${timeAgo(notebook.updated_at)}` : saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Unsaved changes" : "Save failed"}
          </span>
          <span>{cells.length} cells</span>
          {counts.errors > 0 && <span style={{ color: "var(--critical)" }}>{counts.errors} error{counts.errors === 1 ? "" : "s"}</span>}
        </div>
        <div className="actions">
          <label className="cb-check" title="Re-run cells that read from a cell when it runs">
            <input type="checkbox" checked={reactive} onChange={(e) => setReactive(e.target.checked)} />
            <Lightning size={13} /> Reactive
          </label>
          <button className="btn" onClick={runStale} title="Run cells that have no output or whose inputs changed">
            <ArrowsClockwise size={14} /> Run stale
          </button>
          <button className="btn primary" onClick={runAll}>
            <Play size={14} weight="fill" /> Run all
          </button>
          <div style={{ position: "relative" }} ref={menuRef}>
            <button className="btn icon" onClick={() => setMenuOpen((o) => !o)} title="More">
              <DotsThree size={18} weight="bold" />
            </button>
            {menuOpen && (
              <div className="menu" style={{ right: 0, top: 36 }}>
                <button onClick={() => { clearOutputs(); setMenuOpen(false); }}><Broom size={15} /> Clear all outputs</button>
                <button onClick={() => { download(`${name || "notebook"}.json`, JSON.stringify({ name, cells }, null, 2), "application/json"); setMenuOpen(false); }}><DownloadSimple size={15} /> Export JSON</button>
                <button onClick={() => { download(`${name || "notebook"}.md`, exportMarkdown(name, cells), "text/markdown"); setMenuOpen(false); }}><DownloadSimple size={15} /> Export Markdown</button>
                <hr />
                <button className="danger" onClick={deleteNotebook}><Trash size={15} /> Delete notebook</button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="nb-layout">
        <div className="cells">
          {cells.length === 0 && (
            <div className="empty" style={{ border: "1px dashed var(--border-strong)", borderRadius: "var(--r)", marginTop: 12 }}>
              <div className="title">Empty notebook</div>
              <div className="hint">Add a Python, TypeScript, SQL, or Markdown cell to get started. Named cells flow into the cells below as <code>inputs[name]</code>.</div>
            </div>
          )}
          {cells.map((cell, i) => (
            <div key={cell.id}>
              <CellInserter datasets={datasets} hasPrev={cells.slice(0, i).some((c) => c.kind !== "markdown")} onInsert={(c) => insertAt(i, c)} />
              <Cell
                cell={cell}
                index={i}
                focused={focused === cell.id}
                running={running.has(cell.id)}
                queued={queued.has(cell.id)}
                stale={staleByCell[i]}
                editing={editing.has(cell.id)}
                deps={depsByCell[i]}
                connectors={connectors}
                onPatch={(patch) => patchCell(cell.id, patch)}
                onRun={() => runCell(cell.id)}
                onRunAdvance={() => runAdvance(cell.id)}
                onFocus={() => setFocused(cell.id)}
                onBlur={() => setFocused((f) => (f === cell.id ? null : f))}
                onSetEditing={(v) =>
                  setEditing((prev) => {
                    const n = new Set(prev);
                    if (v) n.add(cell.id);
                    else n.delete(cell.id);
                    return n;
                  })
                }
                onMove={(dir) => moveCell(cell.id, dir)}
                onDuplicate={() => duplicateCell(cell.id)}
                onDelete={() => removeCell(cell.id)}
                onGrab={(e) => startDrag(cell.id, e)}
                dropPos={drag && drag.over === cell.id && drag.id !== cell.id ? drag.pos : null}
                dragging={drag?.id === cell.id}
              />
            </div>
          ))}
          <CellInserter datasets={datasets} hasPrev={cells.some((c) => c.kind !== "markdown")} onInsert={(c) => insertAt(cells.length, c)} last />
        </div>

        <aside className="nb-outline">
          {outline.length > 0 && (
            <>
              <div className="h">Outline</div>
              {outline.map((o, i) => (
                <a key={i} href={`#${o.id}`} className={`${o.level >= 3 ? "l3" : ""}${o.kind === "cell" ? " cellref" : ""}`} onClick={(e) => { e.preventDefault(); document.getElementById(o.id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
                  {o.text}
                </a>
              ))}
            </>
          )}
          <div className="stat-row">
            {counts.code > 0 && <span>{counts.code} code</span>}
            {counts.sql > 0 && <span>{counts.sql} sql</span>}
            {counts.markdown > 0 && <span>{counts.markdown} markdown</span>}
          </div>
          <div className="nb-shortcuts">
            <div><span>Run cell</span><span className="kbd">⌘⏎</span></div>
            <div><span>Run and advance</span><span className="kbd">⇧⏎</span></div>
            <div><span>Save now</span><span className="kbd">⌘S</span></div>
            <div><span>Leave editor</span><span className="kbd">esc</span></div>
          </div>
        </aside>
      </div>
    </div>
  );
}
