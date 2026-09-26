import { CheckCircle, Info, Warning, XCircle } from "@phosphor-icons/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RunState, RuntimeName } from "../types";

export function StatusPill({ state }: { state: RunState }) {
  return <span className={`pill ${state}`}>{state}</span>;
}

export function RuntimeBadge({ runtime, full }: { runtime: RuntimeName | "sql"; full?: boolean }) {
  const label = full
    ? { python: "Python", typescript: "TypeScript", javascript: "JavaScript", sql: "SQL" }[runtime]
    : { python: "py", typescript: "ts", javascript: "js", sql: "sql" }[runtime];
  return <span className={`runtime-badge ${runtime}`}>{label}</span>;
}

export function Tile({
  label,
  value,
  sub,
  tone,
  spark,
  delta,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "accent" | "good" | "bad";
  spark?: number[];
  delta?: { value: number; label?: string; upIsGood?: boolean };
}) {
  return (
    <div className={`tile${tone ? ` ${tone}` : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {(sub || delta) && (
        <div className="sub">
          {delta && delta.value !== 0 && (
            <span
              className={`delta ${(delta.upIsGood ?? true) === delta.value > 0 ? "up" : "down"}`}
            >
              {delta.value > 0 ? "+" : ""}
              {delta.value}
              {delta.label ? ` ${delta.label}` : ""}
            </span>
          )}
          {sub}
        </div>
      )}
      {spark && spark.length > 1 && <Sparkline values={spark} className="spark" />}
    </div>
  );
}

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const W = 92;
  const H = 30;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [
    (i / (values.length - 1)) * (W - 2) + 1,
    H - 2 - ((v - min) / span) * (H - 6),
  ]);
  const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg className={className} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <path d={`${d} L${W - 1},${H} L1,${H} Z`} fill="var(--accent)" opacity="0.12" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill="var(--accent)" />
    </svg>
  );
}

export function Empty({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="ico">{icon}</div>}
      <div className="title">{title}</div>
      {hint && <div className="hint">{hint}</div>}
      {action && <div className="actions">{action}</div>}
    </div>
  );
}

export function Banner({
  kind,
  children,
}: {
  kind: "error" | "ok" | "info";
  children: ReactNode;
}) {
  const Icon = kind === "error" ? XCircle : kind === "ok" ? CheckCircle : Info;
  return (
    <div className={`banner ${kind}`}>
      <Icon size={16} weight="fill" />
      <div>{children}</div>
    </div>
  );
}

export function Skeleton({ h = 14, w = "100%", style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, width: w, ...style }} />;
}

// ── toasts ────────────────────────────────────────────────────────────
interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === "error" ? <Warning size={16} weight="fill" /> : <CheckCircle size={16} weight="fill" />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ── helpers ───────────────────────────────────────────────────────────
export function useClickOutside(ref: React.RefObject<HTMLElement>, onOutside: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [ref, onOutside, active]);
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Confirm({
  title,
  body,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onCancel]);
  return (
    <div className="overlay" onMouseDown={onCancel} style={{ alignItems: "center", paddingTop: 0 }}>
      <div className="palette" style={{ width: 420 }} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ padding: "18px 20px 6px" }}>
          <div style={{ color: "var(--ink)", fontWeight: 600, fontSize: 15 }}>{title}</div>
          {body && <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>{body}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "14px 20px 18px" }}>
          <button className="btn" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Simple async confirm hook: `const [confirm, dialog] = useConfirm(); await confirm({...})`. */
export function useConfirm(): [
  (opts: { title: string; body?: ReactNode; confirmLabel?: string }) => Promise<boolean>,
  ReactNode,
] {
  const [state, setState] = useState<{
    opts: { title: string; body?: ReactNode; confirmLabel?: string };
    resolve: (v: boolean) => void;
  } | null>(null);
  const confirm = useCallback(
    (opts: { title: string; body?: ReactNode; confirmLabel?: string }) =>
      new Promise<boolean>((resolve) => setState({ opts, resolve })),
    [],
  );
  const dialog = useMemo(
    () =>
      state ? (
        <Confirm
          {...state.opts}
          onConfirm={() => {
            state.resolve(true);
            setState(null);
          }}
          onCancel={() => {
            state.resolve(false);
            setState(null);
          }}
        />
      ) : null,
    [state],
  );
  return [confirm, dialog];
}
