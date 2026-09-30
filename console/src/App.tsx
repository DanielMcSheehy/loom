import {
  BookOpen,
  Books,
  CaretRight,
  Database,
  Function as FunctionIcon,
  GitBranch,
  MagnifyingGlass,
  Moon,
  Play,
  Sidebar,
  SquaresFour,
  Sun,
} from "@phosphor-icons/react";
import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useEvents } from "./api";
import CommandPalette from "./components/CommandPalette";
import { ToastProvider } from "./components/ui";
import Dashboard from "./pages/Dashboard";
import Data from "./pages/Data";
import Functions from "./pages/Functions";
import NotebookEditor from "./pages/NotebookEditor";
import Notebooks from "./pages/Notebooks";
import RunDetail from "./pages/RunDetail";
import Runs from "./pages/Runs";
import WorkflowDetail from "./pages/WorkflowDetail";
import Workflows from "./pages/Workflows";
import { useTheme } from "./theme";

// Docs content is sizeable and rarely visited; keep it out of the main chunk.
const Docs = lazy(() => import("./pages/docs/Docs"));

// Pages publish their breadcrumb trail into the top bar.
export type Crumb = { label: string; to?: string };
const CrumbCtx = createContext<(crumbs: Crumb[]) => void>(() => {});
export function useCrumbs(crumbs: Crumb[]) {
  const set = useContext(CrumbCtx);
  const key = JSON.stringify(crumbs);
  useEffect(() => {
    set(crumbs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, set]);
}

const NAV: Array<{ to: string; label: string; icon: ReactNode; end?: boolean; key: string }> = [
  { to: "/", label: "Dashboard", icon: <SquaresFour size={18} />, end: true, key: "1" },
  { to: "/workflows", label: "Workflows", icon: <GitBranch size={18} />, key: "2" },
  { to: "/runs", label: "Runs", icon: <Play size={18} />, key: "3" },
  { to: "/notebooks", label: "Notebooks", icon: <BookOpen size={18} />, key: "4" },
  { to: "/functions", label: "Functions", icon: <FunctionIcon size={18} />, key: "5" },
  { to: "/data", label: "Data", icon: <Database size={18} />, key: "6" },
  { to: "/docs", label: "Docs", icon: <Books size={18} />, key: "7" },
];

export default function App() {
  const { theme, toggle } = useTheme();
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("loom.sidebar") === "collapsed");
  const [connected, setConnected] = useState(true);
  const location = useLocation();

  useEvents(() => setConnected(true));
  useEffect(() => {
    // Probe connectivity by watching the SSE socket state via a lightweight ping.
    const t = setInterval(() => {
      fetch("/api/healthz").then((r) => setConnected(r.ok)).catch(() => setConnected(false));
    }, 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const editing =
        (e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable], .cm-editor") != null;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (!editing && e.key === "[" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  useEffect(() => localStorage.setItem("loom.sidebar", collapsed ? "collapsed" : "open"), [collapsed]);
  useEffect(() => setPaletteOpen(false), [location.pathname]);

  const setCrumbsCb = useCallback((c: Crumb[]) => setCrumbs(c), []);

  return (
    <ToastProvider>
      <CrumbCtx.Provider value={setCrumbsCb}>
        <div className={`shell${collapsed ? " collapsed" : ""}`}>
          <aside className="sidebar">
            <Link to="/" className="brand" title="Loom">
              <span className="brand-mark">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M3 3v10h10M6 10l3-4 3 3" />
                </svg>
              </span>
              <span className="nav-label">Loom</span>
              <small>v0.2</small>
            </Link>
            <div className="nav-section">Platform</div>
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`} title={n.label}>
                {n.icon}
                <span className="nav-label">{n.label}</span>
              </NavLink>
            ))}
            <div className="sidebar-foot">
              <button className="nav-link" onClick={toggle} title="Toggle theme" style={{ border: "none", background: "none", cursor: "pointer", width: "100%" }}>
                {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
                <span className="nav-label">{theme === "dark" ? "Light theme" : "Dark theme"}</span>
              </button>
              <button className="nav-link" onClick={() => setCollapsed((c) => !c)} title="Collapse sidebar (⌘[)" style={{ border: "none", background: "none", cursor: "pointer", width: "100%" }}>
                <Sidebar size={17} />
                <span className="nav-label">Collapse</span>
              </button>
            </div>
          </aside>
          <main className="main">
            <header className="topbar">
              <nav className="crumbs" aria-label="Breadcrumb">
                {crumbs.length === 0 ? (
                  <span className="cur">Loom</span>
                ) : (
                  crumbs.map((c, i) => (
                    <span key={i} style={{ display: "contents" }}>
                      {i > 0 && <CaretRight size={12} className="sep" />}
                      {c.to && i < crumbs.length - 1 ? <Link to={c.to}>{c.label}</Link> : <span className="cur">{c.label}</span>}
                    </span>
                  ))
                )}
              </nav>
              <div className="topbar-spacer" />
              <button className="search-btn" onClick={() => setPaletteOpen(true)}>
                <MagnifyingGlass size={15} />
                <span className="lbl">Search or jump to…</span>
                <span className="kbd">⌘K</span>
              </button>
              <span className={`live${connected ? "" : " off"}`} title={connected ? "Connected to server" : "Server unreachable"}>
                <span className="live-dot" />
                {connected ? "live" : "offline"}
              </span>
            </header>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/workflows" element={<Workflows />} />
              <Route path="/workflows/:id" element={<WorkflowDetail />} />
              <Route path="/runs" element={<Runs />} />
              <Route path="/runs/:id" element={<RunDetail />} />
              <Route path="/notebooks" element={<Notebooks />} />
              <Route path="/notebooks/:id" element={<NotebookEditor />} />
              <Route path="/functions" element={<Functions />} />
              <Route path="/data" element={<Data />} />
              <Route path="/ingestion" element={<Navigate to="/data" replace />} />
              <Route path="/docs" element={<Suspense fallback={null}><Docs /></Suspense>} />
              <Route path="/docs/:page" element={<Suspense fallback={null}><Docs /></Suspense>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} theme={theme} onToggleTheme={toggle} />
      </CrumbCtx.Provider>
    </ToastProvider>
  );
}
