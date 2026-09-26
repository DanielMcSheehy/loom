// Global ⌘K palette: navigate anywhere, jump to a workflow / notebook /
// function / dataset, or fire common actions.
import {
  ArrowRight,
  BookOpen,
  Database,
  Function as FunctionIcon,
  GitBranch,
  MagnifyingGlass,
  Moon,
  Play,
  Plus,
  SquaresFour,
  Sun,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import type { Dataset, LoomFunction, Notebook, Workflow } from "../types";

interface Item {
  id: string;
  group: string;
  title: string;
  desc?: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}

export default function CommandPalette({
  open,
  onClose,
  theme,
  onToggleTheme,
}: {
  open: boolean;
  onClose: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [data, setData] = useState<{ wf: Workflow[]; nb: Notebook[]; fn: LoomFunction[]; ds: Dataset[] }>({
    wf: [],
    nb: [],
    fn: [],
    ds: [],
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    setTimeout(() => inputRef.current?.focus(), 10);
    Promise.all([
      api.get<Workflow[]>("/api/workflows").catch(() => []),
      api.get<Notebook[]>("/api/notebooks").catch(() => []),
      api.get<LoomFunction[]>("/api/functions").catch(() => []),
      api.get<Dataset[]>("/api/datasets").catch(() => []),
    ]).then(([wf, nb, fn, ds]) => setData({ wf, nb, fn, ds }));
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (p: string) => () => {
      navigate(p);
      onClose();
    };
    const nav: Item[] = [
      { id: "n-dash", group: "Navigate", title: "Dashboard", icon: <SquaresFour size={16} />, run: go("/") },
      { id: "n-wf", group: "Navigate", title: "Workflows", icon: <GitBranch size={16} />, run: go("/workflows") },
      { id: "n-runs", group: "Navigate", title: "Runs", icon: <Play size={16} />, run: go("/runs") },
      { id: "n-nb", group: "Navigate", title: "Notebooks", icon: <BookOpen size={16} />, run: go("/notebooks") },
      { id: "n-fn", group: "Navigate", title: "Functions", icon: <FunctionIcon size={16} />, run: go("/functions") },
      { id: "n-data", group: "Navigate", title: "Data", icon: <Database size={16} />, run: go("/data") },
    ];
    const actions: Item[] = [
      {
        id: "a-nb",
        group: "Actions",
        title: "New notebook",
        icon: <Plus size={16} />,
        keywords: "create",
        run: () => {
          api
            .post<Notebook>("/api/notebooks", { name: "Untitled notebook", cells: [] })
            .then((nb) => navigate(`/notebooks/${nb.id}`));
          onClose();
        },
      },
      { id: "a-wf", group: "Actions", title: "New workflow", icon: <Plus size={16} />, keywords: "create", run: go("/workflows?new=1") },
      { id: "a-fn", group: "Actions", title: "New function", icon: <Plus size={16} />, keywords: "create deploy", run: go("/functions?new=1") },
      {
        id: "a-theme",
        group: "Actions",
        title: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        icon: theme === "dark" ? <Sun size={16} /> : <Moon size={16} />,
        keywords: "theme dark light mode",
        run: () => {
          onToggleTheme();
          onClose();
        },
      },
    ];
    const wf = data.wf.map<Item>((w) => ({
      id: `wf-${w.id}`,
      group: "Workflows",
      title: w.spec.name,
      desc: `${w.spec.tasks.length} tasks`,
      icon: <GitBranch size={16} />,
      run: go(`/workflows/${w.id}`),
    }));
    const nb = data.nb.map<Item>((n) => ({
      id: `nb-${n.id}`,
      group: "Notebooks",
      title: n.name,
      desc: `${Array.isArray(n.cells) ? n.cells.length : 0} cells`,
      icon: <BookOpen size={16} />,
      run: go(`/notebooks/${n.id}`),
    }));
    const fn = data.fn.map<Item>((f) => ({
      id: `fn-${f.id}`,
      group: "Functions",
      title: f.spec.name,
      desc: f.spec.runtime,
      icon: <FunctionIcon size={16} />,
      run: go(`/functions?name=${encodeURIComponent(f.spec.name)}`),
    }));
    const ds = data.ds.map<Item>((d) => ({
      id: `ds-${d.name}`,
      group: "Datasets",
      title: d.name,
      desc: `${d.records.toLocaleString()} records`,
      icon: <Database size={16} />,
      run: go(`/data?dataset=${encodeURIComponent(d.name)}`),
    }));
    return [...nav, ...actions, ...wf, ...nb, ...fn, ...ds];
  }, [data, navigate, onClose, theme, onToggleTheme]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((i) => `${i.title} ${i.desc ?? ""} ${i.keywords ?? ""} ${i.group}`.toLowerCase().includes(needle));
  }, [items, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".palette-item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(filtered.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      filtered[sel]?.run();
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  let lastGroup = "";
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="palette-input">
          <MagnifyingGlass size={18} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search pages, workflows, notebooks, datasets…"
            aria-label="Command palette"
          />
          <span className="kbd">esc</span>
        </div>
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && <div className="empty">No matches</div>}
          {filtered.map((it, i) => {
            const head = it.group !== lastGroup ? <div className="palette-group">{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {head}
                <div
                  className={`palette-item${i === sel ? " sel" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={it.run}
                >
                  <span className="ico">{it.icon}</span>
                  <div>
                    <div className="t">{it.title}</div>
                    {it.desc && <div className="d">{it.desc}</div>}
                  </div>
                  {i === sel && <ArrowRight size={14} className="right muted" />}
                </div>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span><span className="kbd">↑↓</span> navigate</span>
          <span><span className="kbd">↵</span> open</span>
          <span><span className="kbd">⌘K</span> toggle</span>
        </div>
      </div>
    </div>
  );
}
