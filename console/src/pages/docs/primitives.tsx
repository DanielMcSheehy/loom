// Building blocks for docs pages: anchored headings, copyable code blocks
// (Prism via CodeBlock), multi-language example tabs, tables, callouts, and
// the API endpoint card. Everything here is static markup; the only state is
// the "copied" flash and the shared example-language choice.
import { Check, Copy, Link as LinkIcon } from "@phosphor-icons/react";
import Prism from "prismjs";
import "prismjs/components/prism-bash";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CodeBlock, highlight, type CodeLanguage } from "../../components/CodeBlock";

export type DocLanguage = CodeLanguage | "bash";

// ── headings ─────────────────────────────────────────────────────────────

function Anchor({ id }: { id: string }) {
  return (
    <Link to={`#${id}`} className="doc-anchor" aria-label="Link to this section" title="Copy link to this section">
      <LinkIcon size={13} />
    </Link>
  );
}

export function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="doc-h2">
      {children}
      <Anchor id={id} />
    </h2>
  );
}

export function H3({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="doc-h3">
      {children}
      <Anchor id={id} />
    </h3>
  );
}

// ── prose ────────────────────────────────────────────────────────────────

export function P({ children }: { children: ReactNode }) {
  return <p className="doc-p">{children}</p>;
}

export function Ul({ children }: { children: ReactNode }) {
  return <ul className="doc-ul">{children}</ul>;
}

export function Ol({ children }: { children: ReactNode }) {
  return <ol className="doc-ul doc-ol">{children}</ol>;
}

export function Li({ children }: { children: ReactNode }) {
  return <li>{children}</li>;
}

export function C({ children }: { children: ReactNode }) {
  return <code className="doc-code">{children}</code>;
}

/** Plain strings may carry `backtick` spans; render them as inline code. Elements pass through. */
export function Inline({ children }: { children: ReactNode }) {
  if (typeof children !== "string" || !children.includes("`")) return <>{children}</>;
  const parts = children.split("`");
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 ? <C key={i}>{part}</C> : <span key={i}>{part}</span>))}
    </>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function DocLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="doc-link">
      {children}
    </Link>
  );
}

export function Callout({ kind = "info", title, children }: { kind?: "info" | "warn" | "note"; title?: string; children: ReactNode }) {
  return (
    <div className={`doc-callout ${kind}`}>
      {title && <div className="doc-callout-title">{title}</div>}
      <div>{children}</div>
    </div>
  );
}

export function Table({ head, rows }: { head: ReactNode[]; rows: ReactNode[][] }) {
  return (
    <div className="doc-table-wrap">
      <table className="doc-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A field/parameter table: name, type, default/required, description. */
export function Fields({ rows }: { rows: Array<{ name: string; type: string; note?: string; desc: ReactNode }> }) {
  return (
    <Table
      head={["Field", "Type", "Default", "Description"]}
      rows={rows.map((r) => [<C key="n">{r.name}</C>, <span key="t" className="doc-type">{r.type}</span>, r.note ?? <span className="muted">required</span>, <Inline key="d">{r.desc}</Inline>])}
    />
  );
}

// ── code ─────────────────────────────────────────────────────────────────

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`doc-copy${done ? " done" : ""}`}
      title="Copy to clipboard"
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        }
      }}
    >
      {done ? <Check size={13} weight="bold" /> : <Copy size={13} />}
      <span>{done ? "Copied" : label ?? "Copy"}</span>
    </button>
  );
}

const LANG_LABEL: Record<DocLanguage, string> = {
  python: "Python",
  typescript: "TypeScript",
  javascript: "JavaScript",
  sql: "SQL",
  json: "JSON",
  markdown: "Markdown",
  plain: "Text",
  bash: "Shell",
};

function BashBlock({ code }: { code: string }) {
  const html = useMemo(() => {
    try {
      return Prism.highlight(code, Prism.languages.bash, "bash");
    } catch {
      return highlight(code, "plain");
    }
  }, [code]);
  return (
    <pre className="result-json doc-pre">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

/** Syntax-highlighted, copyable code block. `title` shows in the header. */
export function Code({ code, lang = "plain", title }: { code: string; lang?: DocLanguage; title?: string }) {
  const text = code.replace(/^\n/, "").replace(/\n$/, "");
  return (
    <div className="doc-codeblock">
      <div className="doc-codehead">
        <span className="doc-codelang">{title ?? LANG_LABEL[lang]}</span>
        <CopyButton text={text} />
      </div>
      {lang === "bash" ? <BashBlock code={text} /> : <CodeBlock code={text} language={lang} className="doc-pre" />}
    </div>
  );
}

// ── multi-language examples ──────────────────────────────────────────────

export type ExampleLang = "curl" | "python" | "typescript";
const EXAMPLE_LABEL: Record<ExampleLang, string> = { curl: "curl", python: "Python", typescript: "TypeScript" };
const EXAMPLE_LANG: Record<ExampleLang, DocLanguage> = { curl: "bash", python: "python", typescript: "typescript" };
const ORDER: ExampleLang[] = ["curl", "python", "typescript"];

export const ExampleLangCtx = createContext<[ExampleLang, (l: ExampleLang) => void]>(["curl", () => {}]);

export type ExampleSet = Partial<Record<ExampleLang, string>>;

/** Tabs over the same example in curl / Python / TypeScript. The chosen tab is shared page-wide. */
export function Examples({ examples, title }: { examples: ExampleSet; title?: string }) {
  const [pref, setPref] = useContext(ExampleLangCtx);
  const available = ORDER.filter((l) => examples[l] !== undefined);
  const active = available.includes(pref) ? pref : available[0];
  if (!active) return null;
  const text = (examples[active] ?? "").replace(/^\n/, "").replace(/\n$/, "");
  const lang = EXAMPLE_LANG[active];
  return (
    <div className="doc-codeblock">
      <div className="doc-codehead">
        {title && <span className="doc-codelang">{title}</span>}
        <div className="doc-tabs" role="tablist">
          {available.map((l) => (
            <button key={l} role="tab" aria-selected={l === active} className={l === active ? "on" : ""} onClick={() => setPref(l)}>
              {EXAMPLE_LABEL[l]}
            </button>
          ))}
        </div>
        <CopyButton text={text} />
      </div>
      {lang === "bash" ? <BashBlock code={text} /> : <CodeBlock code={text} language={lang} className="doc-pre" />}
    </div>
  );
}

// ── API endpoint card ────────────────────────────────────────────────────

export type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface ApiRoute {
  method: Method;
  path: string;
  summary: string;
  description?: ReactNode;
  /** Path parameters. */
  params?: Array<{ name: string; desc: ReactNode }>;
  /** Query parameters. */
  query?: Array<{ name: string; type: string; note?: string; desc: ReactNode }>;
  /** Request body fields (JSON unless `bodyNote` says otherwise). */
  body?: Array<{ name: string; type: string; note?: string; desc: ReactNode }>;
  bodyNote?: ReactNode;
  /** Success status, e.g. "201 Created". */
  status: string;
  response: string;
  responseLang?: DocLanguage;
  errors?: Array<{ status: string; when: ReactNode }>;
  examples: ExampleSet;
}

export function routeId(r: { method: string; path: string }): string {
  return `${r.method.toLowerCase()}-${r.path.replace(/[{}]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;
}

export function MethodBadge({ method }: { method: Method }) {
  return <span className={`doc-method ${method.toLowerCase()}`}>{method}</span>;
}

export function Endpoint({ route }: { route: ApiRoute }) {
  const id = routeId(route);
  return (
    <section className="doc-endpoint">
      <h3 id={id} className="doc-h3 doc-endpoint-head" data-toc-title={`${route.method} ${route.path}`}>
        <MethodBadge method={route.method} />
        <code className="doc-path">{route.path}</code>
        <Anchor id={id} />
      </h3>
      <p className="doc-p">
        <strong>{route.summary}</strong>
        {route.description && <> <Inline>{route.description}</Inline></>}
      </p>
      {route.params && route.params.length > 0 && (
        <Table head={["Path parameter", "Description"]} rows={route.params.map((p) => [<C key="n">{p.name}</C>, <Inline key="d">{p.desc}</Inline>])} />
      )}
      {route.query && route.query.length > 0 && (
        <>
          <div className="doc-label">Query parameters</div>
          <Fields rows={route.query} />
        </>
      )}
      {(route.body || route.bodyNote) && (
        <>
          <div className="doc-label">Request body</div>
          {route.bodyNote && <p className="doc-p"><Inline>{route.bodyNote}</Inline></p>}
          {route.body && route.body.length > 0 && <Fields rows={route.body} />}
        </>
      )}
      <div className="doc-label">
        Response <span className="doc-status">{route.status}</span>
      </div>
      <Code code={route.response} lang={route.responseLang ?? "json"} />
      {route.errors && route.errors.length > 0 && (
        <Table head={["Error", "When"]} rows={route.errors.map((e) => [<span key="s" className="doc-status err">{e.status}</span>, <Inline key="w">{e.when}</Inline>])} />
      )}
      <Examples examples={route.examples} title="Example" />
    </section>
  );
}
