// Small markdown renderer for notebook text cells: headings (with ids for
// the outline), bold/italic/strike, inline + fenced code, ordered and
// unordered lists, blockquotes, links, images, tables, rules. Input is
// escaped before formatting so cells can't inject markup.
import { useMemo } from "react";
import { highlight, type CodeLanguage } from "./CodeBlock";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const slug = (s: string) =>
  s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 64);

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<img alt="$1" src="$2" style="max-width:100%;border-radius:6px" />')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+|#[^)\s]*)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

const LANGS: Record<string, CodeLanguage> = { python: "python", py: "python", ts: "typescript", typescript: "typescript", js: "javascript", javascript: "javascript", sql: "sql", json: "json", md: "markdown" };

export function renderMarkdown(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let code: string[] | null = null;
  let codeLang = "";
  let list: "ul" | "ol" | null = null;
  let table: string[][] | null = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const closeTable = () => {
    if (!table) return;
    const [head, ...body] = table;
    out.push("<table><thead><tr>" + head.map((h) => `<th>${inline(h)}</th>`).join("") + "</tr></thead><tbody>");
    for (const r of body) out.push("<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
    out.push("</tbody></table>");
    table = null;
  };
  for (const raw of lines) {
    const line = escapeHtml(raw);
    if (line.trim().startsWith("```")) {
      closeList();
      closeTable();
      if (code) {
        const lang = LANGS[codeLang] ?? "plain";
        out.push(`<pre><code>${highlight(code.join("\n").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'), lang)}</code></pre>`);
        code = null;
      } else {
        code = [];
        codeLang = line.trim().slice(3).trim().toLowerCase();
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      closeList();
      (table ??= []).push(cells);
      continue;
    }
    closeTable();
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      closeList();
      const level = h[1].length;
      out.push(`<h${level} id="${slug(h[2])}">${inline(h[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      closeList();
      out.push("<hr />");
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
      continue;
    }
    closeList();
    const bq = line.match(/^\s*&gt;\s?(.*)/);
    if (bq) {
      out.push(`<blockquote>${inline(bq[1])}</blockquote>`);
      continue;
    }
    if (line.trim() === "") continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  closeTable();
  if (code) out.push(`<pre><code>${code.join("\n")}</code></pre>`);
  return out.join("\n");
}

export function headings(src: string): Array<{ level: number; text: string; id: string }> {
  const out: Array<{ level: number; text: string; id: string }> = [];
  let inCode = false;
  for (const line of src.split("\n")) {
    if (line.trim().startsWith("```")) inCode = !inCode;
    if (inCode) continue;
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) out.push({ level: h[1].length, text: h[2].replace(/[*_`]/g, ""), id: slug(escapeHtml(h[2])) });
  }
  return out;
}

export default function Markdown({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
