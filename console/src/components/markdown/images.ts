// Markdown image helpers shared by the renderer (Markdown.tsx), the resize
// overlay, and the paste/drop inserter: URL safety, the Obsidian-compatible
// size suffix (`![alt|320](url)`, `![alt|320x200](url)`), and rewriting a
// reference's width back into the cell source.

export interface ImageRef {
  /** Ordinal among rendered images (source order, code blocks skipped). */
  index: number;
  /** Character range of the whole `![...](...)` in the source. */
  start: number;
  end: number;
  alt: string;
  url: string;
  width?: number;
  height?: number;
  /** The size suffix was written `\|` (table cell); keep it that way on rewrite. */
  escapedPipe?: boolean;
  /** Inside a `| table | row |` line, where a bare `|` would split the cell. */
  inTable: boolean;
}

/** Only these get a `src`: http(s), data:image/*, and relative paths. */
export function safeImageUrl(url: string): boolean {
  const u = url.trim();
  if (!u || /[\s"'<>]/.test(u)) return false;
  if (/^https?:\/\//i.test(u)) return true;
  if (/^data:image\/[a-z0-9.+-]+(;[a-z0-9=-]+)*(;base64)?,/i.test(u)) return true;
  if (u.startsWith("//")) return false; // protocol-relative: could point anywhere
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return false; // any other scheme (javascript:, blob:, …)
  return true; // relative (`/api/...`, `./x.png`, `x.png`, `#frag`)
}

/** Split an Obsidian-style alt (`caption|320` / `caption|320x200`) into text + size. */
export function parseAlt(rawAlt: string): { alt: string; width?: number; height?: number; escapedPipe?: boolean } {
  // Inside a table cell the pipe is written `\|`; accept both.
  const m = rawAlt.match(/^(.*?)(\\?)\|\s*(\d+)(?:\s*x\s*(\d+))?\s*$/);
  if (!m) return { alt: rawAlt };
  const width = Number(m[3]);
  const height = m[4] ? Number(m[4]) : undefined;
  if (!width) return { alt: m[1] };
  return { alt: m[1], width, height, escapedPipe: m[2] === "\\" };
}

// Same shape the renderer's inline pass uses (see Markdown.tsx). Kept
// identical so the n-th `<img>` in the DOM is the n-th ref here.
export const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/** Mask inline code spans with spaces (offsets preserved) so their contents are never parsed. */
function maskInlineCode(line: string): string {
  return line.replace(/`[^`]+`/g, (m) => " ".repeat(m.length));
}

/** Every image reference in the source, in render order, with offsets. */
export function imageRefs(src: string): ImageRef[] {
  const refs: ImageRef[] = [];
  let inCode = false;
  let offset = 0;
  for (const line of src.split("\n")) {
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
    } else if (!inCode) {
      const masked = maskInlineCode(line);
      const inTable = /^\s*\|.*\|\s*$/.test(line);
      for (const m of masked.matchAll(IMAGE_RE)) {
        const { alt, width, height, escapedPipe } = parseAlt(m[1]);
        refs.push({ index: refs.length, start: offset + m.index!, end: offset + m.index! + m[0].length, alt, url: m[2], width, height, escapedPipe, inTable });
      }
    }
    offset += line.length + 1;
  }
  return refs;
}

/**
 * Rewrite the n-th image's width in the source. `width === null` drops the
 * size suffix (natural size). `url` guards against ordinal drift: when the
 * n-th ref points elsewhere, the first ref with that url is patched instead.
 */
export function setImageWidth(src: string, index: number, width: number | null, url?: string): string {
  const refs = imageRefs(src);
  let ref = refs[index];
  if (!ref || (url !== undefined && ref.url !== url)) ref = refs.find((r) => r.url === url) ?? ref;
  if (!ref) return src;
  const alt = ref.alt.trimEnd();
  const pipe = ref.escapedPipe || ref.inTable ? "\\|" : "|";
  const md = width === null ? `![${alt}](${ref.url})` : `![${alt}${pipe}${Math.round(width)}](${ref.url})`;
  return src.slice(0, ref.start) + md + src.slice(ref.end);
}

/** The markdown for a freshly embedded image. */
export function imageMarkdown(alt: string, url: string): string {
  return `![${alt.replace(/[\[\]|]/g, " ").trim() || "image"}](${url})`;
}
