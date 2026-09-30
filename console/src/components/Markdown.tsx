// Small markdown renderer for notebook text cells: headings (with ids for
// the outline), bold/italic/strike, inline + fenced code, ordered and
// unordered lists, blockquotes, links, images, tables, rules. Input is
// escaped before formatting so cells can't inject markup.
//
// Images: `![alt](url)` with http(s), data:image/* or relative urls, plus
// the Obsidian size suffix `![alt|320](url)` / `![alt|320x200](url)`. Each
// is wrapped in `.md-img` with its ordinal so `useImageResize` can write a
// dragged width back into the source (see markdown/images.ts).
import { useMemo, useRef } from "react";
import { highlight, type CodeLanguage } from "./CodeBlock";
import { IMAGE_RE, parseAlt, safeImageUrl } from "./markdown/images";
import { useImageResize, type ImageResizeHandler } from "./markdown/ImageResize";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const slug = (s: string) =>
  s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 64);

const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Per-render state: images are numbered in source order so resize edits can find them again. */
interface RenderCtx {
  images: number;
}

function image(ctx: RenderCtx, rawAlt: string, escapedUrl: string): string {
  const url = unescapeHtml(escapedUrl);
  const { alt, width, height } = parseAlt(rawAlt);
  const index = ctx.images++;
  // Unsafe scheme: no <img> at all, just a labelled placeholder (keeps the ordinal).
  if (!safeImageUrl(url)) return `<span class="md-img md-img-blocked" data-md-index="${index}" title="Image blocked: only http(s), data:image and relative urls are allowed">${alt || "image"}</span>`;
  const attrs: string[] = [`alt="${alt}"`, `src="${escapedUrl}"`, 'loading="lazy"', 'draggable="false"'];
  if (width) {
    attrs.push(`width="${width}"`, `style="width:${width}px"`);
    if (height) attrs.push(`height="${height}"`);
  }
  return `<span class="md-img" data-md-index="${index}" data-md-src="${escapedUrl}"><img ${attrs.join(" ")} /><span class="md-img-size"></span><span class="md-img-handle" title="Drag to resize · double-click for natural size"></span></span>`;
}

function inline(s: string, ctx: RenderCtx): string {
  // Code spans are lifted out first so their contents are never formatted
  // (`**x**` or `![a](b)` inside backticks stay literal).
  const codes: string[] = [];
  const out = s
    .replace(/`([^`]+)`/g, (_, c: string) => {
      codes.push(`<code>${c}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(IMAGE_RE, (_, alt: string, url: string) => image(ctx, alt, url))
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+|#[^)\s]*)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
}

const LANGS: Record<string, CodeLanguage> = { python: "python", py: "python", ts: "typescript", typescript: "typescript", js: "javascript", javascript: "javascript", sql: "sql", json: "json", md: "markdown" };

export function renderMarkdown(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  const ctx: RenderCtx = { images: 0 };
  const fmt = (s: string) => inline(s, ctx);
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
    out.push("<table><thead><tr>" + head.map((h) => `<th>${fmt(h)}</th>`).join("") + "</tr></thead><tbody>");
    for (const r of body) out.push("<tr>" + r.map((c) => `<td>${fmt(c)}</td>`).join("") + "</tr>");
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
      // `\|` is a literal pipe inside a cell (needed for `![alt\|320](url)`).
      const cells = line.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
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
      out.push(`<h${level} id="${slug(h[2])}">${fmt(h[2])}</h${level}>`);
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
      out.push(`<li>${fmt((ul ?? ol)![1])}</li>`);
      continue;
    }
    closeList();
    const bq = line.match(/^\s*&gt;\s?(.*)/);
    if (bq) {
      out.push(`<blockquote>${fmt(bq[1])}</blockquote>`);
      continue;
    }
    if (line.trim() === "") continue;
    out.push(`<p>${fmt(line)}</p>`);
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

export default function Markdown({ source, onImageResize }: { source: string; onImageResize?: ImageResizeHandler }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  const ref = useRef<HTMLDivElement>(null);
  useImageResize(ref, onImageResize);
  return <div ref={ref} className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
