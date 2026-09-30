// Embedding pasted / dropped image files into a markdown cell as data: URLs.
// Large images are downscaled through a canvas so notebooks stay small.
// The CodeMirror view is looked up lazily (dynamic import) so this module
// never drags the editor chunk into the main bundle.
import type { EditorView } from "@codemirror/view";
import { imageMarkdown } from "./images";

export const MAX_DIMENSION = 1600;
export const MAX_BYTES = 500_000;

export const isImageFile = (f: File) => f.type.startsWith("image/");

/** Image files carried by a paste or drop, if any. */
export function imageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f && isImageFile(f)) out.push(f);
    }
  }
  if (out.length === 0) for (const f of Array.from(dt.files ?? [])) if (isImageFile(f)) out.push(f);
  return out;
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`cannot decode ${file.name || file.type}`));
    };
    img.src = url;
  });
}

/** Byte length of a base64 data URL's payload. */
export function dataUrlBytes(url: string): number {
  const i = url.indexOf(",");
  if (i < 0) return url.length;
  const b64 = url.length - i - 1;
  const pad = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
  return Math.floor((b64 * 3) / 4) - pad;
}

/**
 * File → data URL. Anything at most MAX_DIMENSION px and MAX_BYTES is
 * embedded verbatim (keeps GIF animation / SVG vectors). Bigger images are
 * redrawn on a canvas: scaled to fit, then re-encoded — WebP where the
 * browser can (alpha + small), else JPEG for photos, else PNG — with the
 * quality / scale stepped down until under the byte budget.
 */
export async function fileToDataUrl(file: File): Promise<string> {
  const isSvg = file.type === "image/svg+xml";
  if (file.size <= MAX_BYTES && (isSvg || file.type === "image/gif")) return readAsDataUrl(file);
  const img = await loadImage(file);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (file.size <= MAX_BYTES && Math.max(w, h) <= MAX_DIMENSION) return readAsDataUrl(file);

  let scale = Math.min(1, MAX_DIMENSION / Math.max(w, h));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return readAsDataUrl(file);
  const draw = () => {
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  const photo = file.type === "image/jpeg";
  const encode = (quality: number) => {
    const webp = canvas.toDataURL("image/webp", quality);
    if (webp.startsWith("data:image/webp")) return webp;
    return photo ? canvas.toDataURL("image/jpeg", quality) : canvas.toDataURL("image/png");
  };
  let quality = 0.86;
  let out = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    draw();
    out = encode(quality);
    if (dataUrlBytes(out) <= MAX_BYTES) break;
    if (quality > 0.6 && !out.startsWith("data:image/png")) quality -= 0.12;
    else scale *= 0.8;
  }
  return out;
}

/** Markdown for one embedded file, alt derived from the filename. */
export async function fileToMarkdown(file: File): Promise<string> {
  const alt = file.name ? file.name.replace(/\.[a-z0-9]+$/i, "") : "pasted image";
  return imageMarkdown(alt === "image" ? "pasted image" : alt, await fileToDataUrl(file));
}

/** The CodeMirror view mounted under `host`, if the editor chunk has loaded. */
export async function findEditorView(host: HTMLElement | null): Promise<EditorView | null> {
  if (!host || !host.querySelector(".cm-content")) return null;
  const { EditorView: View } = await import("@codemirror/view");
  return View.findFromDOM(host);
}

/**
 * Insert markdown at the cursor (or at drop coordinates) on its own line.
 * Returns false when no editor view is available so the caller can fall
 * back to patching the document text directly.
 */
export function insertBlockAt(view: EditorView, text: string, at?: { x: number; y: number }): void {
  let pos = view.state.selection.main.head;
  if (at) {
    const p = view.posAtCoords(at);
    if (p !== null) pos = p;
  }
  const line = view.state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const after = line.text.slice(pos - line.from);
  // Own line before, and the cursor lands on a fresh line after — never at
  // the end of a data: URL that can be hundreds of KB long.
  const insert = (before.trim() ? "\n" : "") + text + "\n";
  view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, scrollIntoView: true });
  view.focus();
}

/** Fallback when the editor isn't mounted: append as a block. */
export function appendBlock(code: string, text: string): string {
  if (!code.trim()) return text;
  return code.replace(/\s*$/, "") + "\n\n" + text;
}
