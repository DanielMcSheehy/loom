// Extract the plain text of a static React element tree without rendering
// it — the docs search index is built from page bodies this way. Walks
// children and string props (code samples, table cells, example sets), so a
// query matches endpoint paths and code, not just headings.
import { isValidElement, type ReactNode } from "react";
import { Endpoint, H2, H3, routeId } from "./primitives";

const MAX_DEPTH = 40;

export function textOf(node: unknown, depth = 0): string {
  if (depth > MAX_DEPTH || node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string") return node + " ";
  if (typeof node === "number") return String(node) + " ";
  if (Array.isArray(node)) return node.map((n) => textOf(n, depth + 1)).join("");
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    let out = "";
    for (const [k, v] of Object.entries(props)) {
      if (k === "className" || k === "style" || k === "id" || k === "to" || k === "href" || typeof v === "function") continue;
      out += textOf(v, depth + 1);
    }
    return out;
  }
  if (typeof node === "object") {
    let out = "";
    for (const v of Object.values(node as Record<string, unknown>)) {
      if (typeof v === "function") continue;
      out += textOf(v, depth + 1);
    }
    return out;
  }
  return "";
}

/** Section headings (`H2`/`H3` with an id) in document order, for search hits and the outline. */
export function headingsOf(node: ReactNode, depth = 0): Array<{ id: string; title: string; level: 2 | 3 }> {
  if (depth > MAX_DEPTH || node === null || node === undefined || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((n) => headingsOf(n as ReactNode, depth + 1));
  if (!isValidElement(node)) return [];
  const props = node.props as Record<string, unknown>;
  // Compare by identity, not by function name: names are mangled in production builds.
  if ((node.type === H2 || node.type === H3) && typeof props.id === "string") {
    return [{ id: props.id, title: textOf(props.children).trim(), level: node.type === H2 ? 2 : 3 }];
  }
  if (node.type === Endpoint && props.route && typeof props.route === "object") {
    const r = props.route as { method: string; path: string };
    return [{ id: routeId(r), title: `${r.method} ${r.path}`, level: 3 }];
  }
  return headingsOf(props.children as ReactNode, depth + 1);
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
