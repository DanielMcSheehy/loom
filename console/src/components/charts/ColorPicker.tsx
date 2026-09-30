// Per-series colour override: a swatch per series that opens a small
// popover with the categorical palette (theme-aware `var(--sN)` tokens)
// plus a native colour input for a custom hex. Picks are persisted in
// `ChartSpec.colors`; an unset entry falls back to the palette slot.
import { useEffect, useRef, useState } from "react";
import { seriesColor } from "./Chart";
import "./charts.css";

export const PALETTE = Array.from({ length: 8 }, (_, i) => seriesColor(i));

/** Resolve `var(--sN)` (or any colour) to a #rrggbb the native input accepts. */
export function resolveHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  if (typeof document === "undefined") return "#888888";
  const m = color.match(/^var\((--[\w-]+)\)$/);
  const raw = m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() : color;
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(raw)) return ("#" + raw.slice(1).split("").map((c) => c + c).join("")).toLowerCase();
  const probe = document.createElement("span");
  probe.style.color = raw;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+/g);
  probe.remove();
  if (!rgb || rgb.length < 3) return "#888888";
  return "#" + rgb.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

export default function ColorPicker({
  entries,
  colors,
  onChange,
}: {
  /** Series / slice names with their default palette slot. */
  entries: Array<{ name: string; slot: number }>;
  colors: Record<string, string> | undefined;
  onChange: (colors: Record<string, string> | undefined) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const set = (name: string, value: string | undefined) => {
    const next = { ...(colors ?? {}) };
    if (value === undefined) delete next[name];
    else next[name] = value;
    onChange(Object.keys(next).length ? next : undefined);
  };

  return (
    <div className="cb-colors" ref={ref}>
      {entries.map((e) => {
        const current = colors?.[e.name];
        const shown = current ?? seriesColor(e.slot);
        const isOpen = open === e.name;
        return (
          <div className="cb-color-row" key={e.name}>
            <button
              type="button"
              className={`color-swatch-btn${isOpen ? " on" : ""}`}
              style={{ background: shown }}
              title={`Color for ${e.name}`}
              aria-label={`Color for ${e.name}`}
              data-series={e.name}
              onClick={() => setOpen(isOpen ? null : e.name)}
            />
            <span className="name" title={e.name}>
              {e.name}
            </span>
            {current && (
              <button type="button" className="reset" title="Reset to palette color" onClick={() => set(e.name, undefined)}>
                ×
              </button>
            )}
            {isOpen && (
              <div className="color-pop" role="dialog" aria-label={`Color for ${e.name}`}>
                <div className="pop-title">
                  Color <span className="name">{e.name}</span>
                </div>
                <div className="cp-swatches">
                  {PALETTE.map((c, i) => (
                    <button
                      key={c}
                      type="button"
                      className={shown === c ? "on" : ""}
                      style={{ background: c }}
                      title={`Palette ${i + 1}`}
                      onClick={() => set(e.name, c)}
                    />
                  ))}
                </div>
                <label className="custom">
                  <input type="color" value={resolveHex(shown)} onChange={(ev) => set(e.name, ev.target.value)} />
                  Custom
                  <code>{resolveHex(shown)}</code>
                </label>
                <div className="pop-actions">
                  {current && (
                    <button type="button" className="btn sm ghost" onClick={() => set(e.name, undefined)}>
                      Reset
                    </button>
                  )}
                  <button type="button" className="btn sm" onClick={() => setOpen(null)}>
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
