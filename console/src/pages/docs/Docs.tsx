// Documentation section: /docs and /docs/:page. Left nav with a filter,
// content column, right-hand "On this page" outline built from the rendered
// headings, prev/next links, and deep-linkable anchors. Page bodies are
// static element trees in `content/`, so search runs over their text without
// rendering them; this whole module is lazy-loaded from App.
import { ArrowLeft, ArrowRight, CaretDown, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { useCrumbs } from "../../App";
import { BODIES } from "./content";
import "./docs.css";
import { DOC_PAGES, DOC_SECTIONS, pageBySlug, type DocPageMeta } from "./meta";
import { ExampleLangCtx, type ExampleLang } from "./primitives";
import { headingsOf, normalize, textOf } from "./text";

interface IndexEntry {
  meta: DocPageMeta;
  text: string;
  headings: Array<{ id: string; title: string; level: 2 | 3 }>;
}

interface Hit {
  meta: DocPageMeta;
  score: number;
  headings: Array<{ id: string; title: string }>;
}

function buildIndex(): IndexEntry[] {
  return DOC_PAGES.map((meta) => ({
    meta,
    text: normalize(`${meta.title} ${meta.summary} ${meta.keywords ?? ""} ${textOf(BODIES[meta.slug])}`),
    headings: headingsOf(BODIES[meta.slug]),
  }));
}

function search(index: IndexEntry[], q: string): Hit[] {
  const terms = normalize(q).split(" ").filter(Boolean);
  if (terms.length === 0) return [];
  const hits: Hit[] = [];
  for (const entry of index) {
    if (!terms.every((t) => entry.text.includes(t))) continue;
    let score = 1;
    const title = normalize(entry.meta.title);
    const summary = normalize(`${entry.meta.summary} ${entry.meta.keywords ?? ""}`);
    if (terms.every((t) => title.includes(t))) score += 6;
    else if (terms.some((t) => title.includes(t))) score += 3;
    if (terms.some((t) => summary.includes(t))) score += 2;
    const headings = entry.headings.filter((h) => {
      const ht = normalize(h.title);
      return terms.some((t) => ht.includes(t));
    });
    score += Math.min(3, headings.length);
    hits.push({ meta: entry.meta, score, headings: headings.slice(0, 5) });
  }
  return hits.sort((a, b) => b.score - a.score);
}

const LANG_KEY = "loom.docs.lang";

export default function Docs() {
  const { page: slugParam } = useParams();
  const slug = slugParam ?? "overview";
  const meta = pageBySlug(slug);
  const location = useLocation();
  const [q, setQ] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [lang, setLangState] = useState<ExampleLang>(() => {
    const v = localStorage.getItem(LANG_KEY);
    return v === "python" || v === "typescript" || v === "curl" ? v : "curl";
  });
  const setLang = (l: ExampleLang) => {
    setLangState(l);
    localStorage.setItem(LANG_KEY, l);
  };
  const index = useMemo(buildIndex, []);
  const hits = useMemo(() => search(index, q), [index, q]);

  useCrumbs(meta ? [{ label: "Docs", to: "/docs" }, { label: meta.title }] : [{ label: "Docs" }]);

  // Deep links: scroll to the hash target (headings carry scroll-margin for
  // the sticky top bar); a page change without a hash starts at the top.
  useEffect(() => {
    const id = location.hash.replace(/^#/, "");
    if (id) {
      const el = document.getElementById(decodeURIComponent(id));
      if (el) {
        el.scrollIntoView({ block: "start" });
        return;
      }
    }
    window.scrollTo({ top: 0 });
  }, [slug, location.hash]);

  useEffect(() => setNavOpen(false), [slug]);

  if (!meta) return <Navigate to="/docs" replace />;
  const idx = DOC_PAGES.findIndex((p) => p.slug === slug);
  const prev = idx > 0 ? DOC_PAGES[idx - 1] : null;
  const next = idx < DOC_PAGES.length - 1 ? DOC_PAGES[idx + 1] : null;

  return (
    <ExampleLangCtx.Provider value={[lang, setLang]}>
      <div className="content wide docs">
        <div className={`docs-layout${navOpen ? " nav-open" : ""}`}>
          <aside className="docs-nav">
            <button className="docs-nav-toggle" onClick={() => setNavOpen((o) => !o)} aria-expanded={navOpen}>
              <span>{meta.section} / {meta.title}</span>
              <CaretDown size={14} />
            </button>
            <div className="docs-nav-body">
              <label className="docs-search">
                <MagnifyingGlass size={14} />
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search docs…"
                  aria-label="Search documentation"
                  onKeyDown={(e) => e.key === "Escape" && setQ("")}
                />
                {q && (
                  <button className="docs-search-clear" onClick={() => setQ("")} aria-label="Clear search">
                    <X size={12} />
                  </button>
                )}
              </label>
              {q.trim() ? (
                <div className="docs-results" role="list">
                  {hits.length === 0 && <div className="docs-empty">No pages match “{q}”.</div>}
                  {hits.map((h) => (
                    <div key={h.meta.slug} className="docs-result" role="listitem">
                      <Link to={`/docs/${h.meta.slug}`} className={`docs-nav-link${h.meta.slug === slug ? " active" : ""}`}>
                        <span className="t">{h.meta.title}</span>
                        <span className="s">{h.meta.section}</span>
                      </Link>
                      {h.headings.length > 0 && (
                        <div className="docs-result-heads">
                          {h.headings.map((hd) => (
                            <Link key={hd.id} to={`/docs/${h.meta.slug}#${hd.id}`}>
                              {hd.title}
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                DOC_SECTIONS.map((section) => (
                  <div key={section} className="docs-nav-section">
                    <div className="docs-nav-head">{section}</div>
                    {DOC_PAGES.filter((p) => p.section === section).map((p) => (
                      <Link key={p.slug} to={`/docs/${p.slug}`} className={`docs-nav-link${p.slug === slug ? " active" : ""}`} title={p.summary}>
                        <span className="t">{p.title}</span>
                      </Link>
                    ))}
                  </div>
                ))
              )}
            </div>
          </aside>

          <article className="docs-article" key={slug}>
            <div className="docs-eyebrow">{meta.section}</div>
            <h1 className="docs-title">{meta.title}</h1>
            <p className="docs-summary">{meta.summary}</p>
            {BODIES[slug]}
            <nav className="docs-pager" aria-label="Previous and next page">
              {prev ? (
                <Link to={`/docs/${prev.slug}`} className="docs-pager-link prev">
                  <ArrowLeft size={14} />
                  <span>
                    <small>Previous</small>
                    {prev.title}
                  </span>
                </Link>
              ) : (
                <span />
              )}
              {next ? (
                <Link to={`/docs/${next.slug}`} className="docs-pager-link next">
                  <span>
                    <small>Next</small>
                    {next.title}
                  </span>
                  <ArrowRight size={14} />
                </Link>
              ) : (
                <span />
              )}
            </nav>
          </article>

          <Toc slug={slug} />
        </div>
      </div>
    </ExampleLangCtx.Provider>
  );
}

// "On this page": h2/h3 with ids from the rendered article, with a scroll spy.
function Toc({ slug }: { slug: string }) {
  const [items, setItems] = useState<Array<{ id: string; title: string; level: number }>>([]);
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLHeadingElement>(".docs-article h2[id], .docs-article h3[id]"));
    setItems(nodes.map((n) => ({ id: n.id, title: n.dataset.tocTitle ?? n.textContent?.replace(/\s+/g, " ").trim() ?? n.id, level: n.tagName === "H2" ? 2 : 3 })));
    const onScroll = () => {
      const offset = 96;
      let current = nodes[0]?.id ?? "";
      for (const n of nodes) {
        if (n.getBoundingClientRect().top - offset <= 0) current = n.id;
        else break;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [slug]);

  if (items.length === 0) return <aside className="docs-toc" />;
  return (
    <aside className="docs-toc">
      <div className="docs-toc-head">On this page</div>
      <nav>
        {items.map((it) => (
          <Link key={it.id} to={`#${it.id}`} className={`docs-toc-link l${it.level}${it.id === active ? " active" : ""}`}>
            {it.title}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
