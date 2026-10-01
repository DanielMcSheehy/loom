// A published notebook as an anonymous visitor sees it: the stored document,
// read-only. No execution, no saving, no editor — only GET /api/notebooks/{id},
// which the server answers without a session when the notebook is public.
import { Globe, Moon, SignIn, Sun } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { api, timeAgo } from "../api";
import { headings } from "../components/Markdown";
import ReadOnlyCell from "../components/notebook/ReadOnlyCell";
import type { Theme } from "../theme";
import type { Notebook } from "../types";

export default function PublishedNotebook({
  id,
  onLogin,
  onUnavailable,
  theme,
  onToggleTheme,
}: {
  id: string;
  /** "Log in to edit". */
  onLogin: () => void;
  /** Not public (or gone) — the server doesn't say which; the caller shows login. */
  onUnavailable: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const [notebook, setNotebook] = useState<Notebook | null>(null);

  useEffect(() => {
    let live = true;
    setNotebook(null);
    api
      .get<Notebook>(`/api/notebooks/${id}`)
      .then((nb) => live && setNotebook(nb))
      .catch(() => live && onUnavailable());
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!notebook) return;
    const before = document.title;
    document.title = `${notebook.name || "Untitled notebook"} · Loom`;
    return () => {
      document.title = before;
    };
  }, [notebook]);

  const cells = useMemo(() => (Array.isArray(notebook?.cells) ? notebook.cells : []), [notebook]);
  const outline = useMemo(() => {
    const items: Array<{ id: string; text: string; level: number; kind: "h" | "cell" }> = [];
    for (const c of cells) {
      if (c.kind === "markdown") for (const h of headings(c.code)) items.push({ id: `cell-${c.id}`, text: h.text, level: h.level, kind: "h" });
      else if (c.name) items.push({ id: `cell-${c.id}`, text: c.name, level: 3, kind: "cell" });
    }
    return items;
  }, [cells]);
  const counts = useMemo(() => {
    const n = { code: 0, sql: 0, markdown: 0 };
    for (const c of cells) n[c.kind]++;
    return n;
  }, [cells]);

  return (
    <div className="published">
      <header className="topbar">
        <span className="brand" style={{ padding: 0 }}>
          <span className="brand-mark">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M3 3v10h10M6 10l3-4 3 3" />
            </svg>
          </span>
          Loom
        </span>
        <div className="topbar-spacer" />
        <button className="btn icon ghost" onClick={onToggleTheme} title="Toggle theme">
          {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <button className="btn" onClick={onLogin}>
          <SignIn size={14} /> Log in
        </button>
      </header>

      <div className="content reading">
        <div className="pub-banner" role="note">
          <Globe size={15} />
          <span>
            <strong>Published notebook · read-only</strong>
            <span className="sub">Outputs are shown as last saved. Nothing here can be run or changed.</span>
          </span>
          <a
            href="#login"
            onClick={(e) => {
              e.preventDefault();
              onLogin();
            }}
          >
            Log in to edit
          </a>
        </div>

        {!notebook ? (
          <>
            <div className="skeleton" style={{ height: 34, width: 320, marginBottom: 20 }} />
            <div className="skeleton" style={{ height: 120, marginBottom: 12 }} />
            <div className="skeleton" style={{ height: 180 }} />
          </>
        ) : (
          <>
            <h1 className="nb-title static">{notebook.name || "Untitled notebook"}</h1>
            <div className="nb-head" style={{ marginBottom: 14 }}>
              <div className="meta">
                <span>{cells.length} cells</span>
                <span>Updated {timeAgo(notebook.updated_at)}</span>
              </div>
            </div>
            <div className="nb-layout">
              <div className="cells">
                {cells.length === 0 && (
                  <div className="empty" style={{ border: "1px dashed var(--border-strong)", borderRadius: "var(--r)", marginTop: 12 }}>
                    <div className="title">Empty notebook</div>
                    <div className="hint">Nothing has been added to this notebook yet.</div>
                  </div>
                )}
                {cells.map((cell, i) => (
                  <ReadOnlyCell key={cell.id} cell={cell} index={i} />
                ))}
              </div>
              <aside className="nb-outline">
                {outline.length > 0 && (
                  <>
                    <div className="h">Outline</div>
                    {outline.map((o, i) => (
                      <a
                        key={i}
                        href={`#${o.id}`}
                        className={`${o.level >= 3 ? "l3" : ""}${o.kind === "cell" ? " cellref" : ""}`}
                        onClick={(e) => {
                          e.preventDefault();
                          document.getElementById(o.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                        }}
                      >
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
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
