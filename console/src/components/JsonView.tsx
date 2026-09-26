// Collapsible JSON tree for non-tabular results.
import { useState } from "react";

function Node({ k, v, depth, last }: { k?: string; v: unknown; depth: number; last: boolean }) {
  const isObj = v !== null && typeof v === "object";
  const [open, setOpen] = useState(depth < 2);
  const pad = "  ".repeat(depth);
  const comma = last ? "" : ",";
  const key = k !== undefined ? (
    <>
      <span className="k">"{k}"</span>
      <span className="p">: </span>
    </>
  ) : null;
  if (!isObj) {
    const cls = typeof v === "string" ? "s" : typeof v === "number" ? "n" : typeof v === "boolean" ? "b" : "z";
    return (
      <div className="row">
        {pad}
        {key}
        <span className={cls}>{JSON.stringify(v)}</span>
        <span className="p">{comma}</span>
      </div>
    );
  }
  const arr = Array.isArray(v);
  const entries = arr ? (v as unknown[]).map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
  const [o, c] = arr ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) {
    return (
      <div className="row">
        {pad}
        {key}
        <span className="p">{o}{c}{comma}</span>
      </div>
    );
  }
  return (
    <>
      <div className="row">
        {pad}
        <span className="tog" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"}
        </span>
        {key}
        <span className="p">{o}</span>
        {!open && (
          <>
            <span className="cnt"> {entries.length} {arr ? "items" : "keys"} </span>
            <span className="p">{c}{comma}</span>
          </>
        )}
      </div>
      {open && (
        <>
          {entries.slice(0, 500).map(([ck, cv], i) => (
            <Node key={ck} k={arr ? undefined : ck} v={cv} depth={depth + 1} last={i === entries.length - 1} />
          ))}
          {entries.length > 500 && <div className="row cnt">{pad}  … {entries.length - 500} more</div>}
          <div className="row">
            {pad}
            <span className="p">{c}{comma}</span>
          </div>
        </>
      )}
    </>
  );
}

export default function JsonView({ value }: { value: unknown }) {
  return (
    <div className="json-view">
      <Node v={value} depth={0} last />
    </div>
  );
}
