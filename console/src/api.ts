import { useEffect, useRef } from "react";
import type { LoomEvent } from "./types";

/** A non-2xx API response; `message` is the server's `{"error"}` text. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// The app shell listens for 401s so an expired / revoked session lands on
// the login screen instead of leaving pages half-loaded.
const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => void unauthorizedListeners.delete(listener);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": typeof body === "string" ? "application/x-ndjson" : "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = await res.text();
    try {
      detail = (JSON.parse(detail) as { error?: string }).error ?? detail;
    } catch {
      /* raw text */
    }
    if (res.status === 401) unauthorizedListeners.forEach((l) => l());
    throw new ApiError(res.status, detail || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── auth (LOOM_PASSWORD) ────────────────────────────────────────────────
export interface AuthStatus {
  /** The server has a password set. */
  enabled: boolean;
  /** This browser has full access (always true when auth is disabled). */
  authenticated: boolean;
}

export const auth = {
  status: async (): Promise<AuthStatus> => {
    const res = await fetch("/api/auth/status");
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
    return (await res.json()) as AuthStatus;
  },
  /** Resolves on success (the session cookie is set); rejects with the server's message. */
  login: async (password: string): Promise<void> => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) return;
    const detail = await res.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(res.status, detail?.error ?? `HTTP ${res.status}`);
  },
  logout: async (): Promise<void> => {
    await fetch("/api/auth/logout", { method: "POST" });
  },
};

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

/** Subscribe to the server's live SSE stream (optionally scoped to a run). */
export function useEvents(onEvent: (ev: LoomEvent) => void, runId?: string) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    const source = new EventSource(runId ? `/api/runs/${runId}/events` : "/api/events");
    source.onmessage = (msg) => {
      try {
        handler.current(JSON.parse(msg.data) as LoomEvent);
      } catch {
        /* malformed frame — skip */
      }
    };
    return () => source.close();
  }, [runId]);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n;
  let unit = "B";
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

export function formatDuration(startIso?: string | null, endIso?: string | null): string {
  if (!startIso) return "—";
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const ms = end - new Date(startIso).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  return `${mins}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  const compact = (v: number, unit: string, decimals: number) => `${v.toFixed(decimals).replace(/\.0$/, "")}${unit}`;
  if (abs >= 1_000_000_000) return compact(n / 1_000_000_000, "B", abs >= 1e10 ? 0 : 1);
  if (abs >= 1_000_000) return compact(n / 1_000_000, "M", abs >= 1e7 ? 0 : 1);
  if (abs >= 10_000) return compact(n / 1_000, "K", abs >= 1e5 ? 0 : 1);
  if (Number.isInteger(n)) return n.toLocaleString();
  return abs < 1 ? n.toPrecision(3) : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function download(filename: string, content: string, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
