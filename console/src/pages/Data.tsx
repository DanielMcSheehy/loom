// Data: dataset catalog with column profiles (server-side Polars), a SQL
// workbench with schema hints + history, streaming NDJSON ingest, and
// external connectors.
import {
  ArrowRight,
  Clock,
  Database,
  Play,
  Plugs,
  Plus,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, formatBytes, formatNumber, timeAgo, useEvents } from "../api";
import { useCrumbs } from "../App";
import type { ColType } from "../components/charts/data";
import CodeEditor from "../components/CodeEditor";
import DataGrid, { TypeIcon } from "../components/DataGrid";
import ResultView from "../components/ResultView";
import { Banner, Empty, Skeleton, useConfirm, useToast } from "../components/ui";
import type { Connector, ConnectorKind, Dataset, DatasetProfile } from "../types";

interface QueryResponse {
  rows: Array<Record<string, unknown>>;
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
}

const HISTORY_KEY = "loom.sql.history";
const table = (name: string) => name.replace(/-/g, "_");

function dtypeToCol(dtype: string): ColType {
  if (dtype === "integer" || dtype === "float") return "number";
  if (dtype === "datetime") return "date";
  if (dtype === "boolean") return "boolean";
  if (dtype === "list" || dtype === "struct") return "object";
  return "string";
}

function fmtBound(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return formatNumber(v);
  return String(v).slice(0, 18);
}

// ── workbench ────────────────────────────────────────────────────────
function Workbench({
  datasets,
  connectors,
  selected,
  profile,
  initialSql,
}: {
  datasets: Dataset[];
  connectors: Connector[];
  selected: string | null;
  profile: DatasetProfile | null;
  initialSql?: string;
}) {
  const [sql, setSql] = useState(initialSql ?? (selected ? `SELECT *\nFROM ${table(selected)}\nLIMIT 100` : datasets[0] ? `SELECT *\nFROM ${table(datasets[0].name)}\nLIMIT 100` : "SELECT 1 AS one"));
  const [connector, setConnector] = useState("");
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Array<{ sql: string; ms: number; rows: number; at: string }>>(() => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  const lastSelected = useRef(selected);
  useEffect(() => {
    if (initialSql) setSql(initialSql);
  }, [initialSql]);
  useEffect(() => {
    if (selected && selected !== lastSelected.current && !initialSql) setSql(`SELECT *\nFROM ${table(selected)}\nLIMIT 100`);
    lastSelected.current = selected;
  }, [selected, initialSql]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<QueryResponse>("/api/query", { sql, limit: 5000, connector: connector || undefined });
      setResult(res);
      const entry = { sql, ms: res.elapsed_ms, rows: res.row_count, at: new Date().toISOString() };
      const next = [entry, ...history.filter((h) => h.sql !== sql)].slice(0, 30);
      setHistory(next);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const insert = (text: string) => setSql((s) => (s.endsWith("\n") || s === "" ? s + text : s + " " + text));

  return (
    <div className="split" style={{ gridTemplateColumns: "minmax(0, 1fr) 240px" }}>
      <div>
        <div className="card">
          <div className="card-head">
            <h2>SQL</h2>
            <div className="actions">
              <select className="inline" value={connector} onChange={(e) => setConnector(e.target.value)}>
                <option value="">datasets · polars</option>
                {connectors.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} · {c.kind}
                  </option>
                ))}
              </select>
              <button className="btn primary sm" disabled={busy} onClick={run}>
                <Play size={12} weight="fill" /> {busy ? "Running…" : "Run"} <span className="kbd" style={{ marginLeft: 2, borderColor: "rgba(255,255,255,.35)", color: "#fff", background: "transparent" }}>⌘⏎</span>
              </button>
            </div>
          </div>
          <div className="editor-wrap">
            <div className="cm-host" style={{ border: "none", borderRadius: 0 }}>
              <CodeEditor value={sql} language="sql" minRows={5} onChange={setSql} onRun={run} />
            </div>
          </div>
        </div>
        {error && <div style={{ marginTop: 12 }}><Banner kind="error">{error}</Banner></div>}
        {result && (
          <div className="section">
            <div className="toolbar" style={{ marginBottom: 8, fontSize: 12, color: "var(--ink-3)" }}>
              <span>
                <b style={{ color: "var(--ink)" }}>{result.row_count.toLocaleString()}</b> row{result.row_count === 1 ? "" : "s"}
                {result.truncated ? " (truncated at 5,000)" : ""} in {result.elapsed_ms}ms
              </span>
            </div>
            {result.rows.length > 0 ? <ResultView value={result.rows} filename="query" /> : <div className="card"><Empty title="Query returned no rows" /></div>}
          </div>
        )}
      </div>
      <div>
        <div className="card">
          <div className="card-head"><h2>Schema</h2>{selected && <span className="sub mono">{table(selected)}</span>}</div>
          {!selected ? (
            <div className="empty" style={{ padding: 20 }}>
              <div className="hint">Select a dataset to see its columns.</div>
            </div>
          ) : !profile ? (
            <div style={{ padding: 12 }}><Skeleton h={12} /><Skeleton h={12} w="70%" style={{ marginTop: 8 }} /></div>
          ) : (
            <div className="schema-list">
              {profile.columns.map((c) => (
                <div key={c.name} className="schema-row" style={{ gridTemplateColumns: "1fr auto" }} title="Insert column name" onClick={() => insert(c.name)}>
                  <span className="c"><TypeIcon type={dtypeToCol(c.dtype)} /> {c.name}</span>
                  <span className="ty">{c.dtype}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", display: "flex", flexWrap: "wrap", gap: 4 }}>
            {datasets.map((d) => (
              <button key={d.name} className="chip" style={{ cursor: "pointer", background: "none" }} onClick={() => insert(table(d.name))}>
                {table(d.name)}
              </button>
            ))}
          </div>
        </div>
        {history.length > 0 && (
          <div className="card">
            <div className="card-head"><h2><Clock size={14} /> History</h2></div>
            {history.slice(0, 10).map((h, i) => (
              <div key={i} className="qh-item" onClick={() => setSql(h.sql)} title={h.sql}>
                <span className="q">{h.sql.replace(/\s+/g, " ")}</span>
                <span className="m">{h.rows} · {h.ms}ms</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── ingest ───────────────────────────────────────────────────────────
function IngestPanel({ defaultName, onDone }: { defaultName?: string; onDone: (name: string) => void }) {
  const [name, setName] = useState(defaultName ?? "");
  const [payload, setPayload] = useState('{"sensor": "a", "value": 0.72}\n{"sensor": "b", "value": 0.41}');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const ingest = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = file ? await file.text() : payload;
      const res = await api.post<{ ingested: { records: number; bytes: number }; triggered_runs: string[] }>(`/api/ingest/${name}`, body);
      toast(`Ingested ${res.ingested.records.toLocaleString()} records (${formatBytes(res.ingested.bytes)}) into ${name}${res.triggered_runs.length ? `, triggered ${res.triggered_runs.length} run(s)` : ""}`);
      setFile(null);
      onDone(name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2><UploadSimple size={15} /> Ingest NDJSON</h2>
        <span className="sub">one JSON object per line · appends to the dataset · fires on_ingest triggers</span>
      </div>
      <div className="card-body">
        {error && <Banner kind="error">{error}</Banner>}
        <div className="form-row">
          <label className="field" style={{ flex: "0 0 260px" }}>
            <span>Dataset name</span>
            <input type="text" value={name} placeholder="sensor-readings" onChange={(e) => setName(e.target.value)} />
            <span className="help">letters, digits, - and _ (max 64)</span>
          </label>
          <label className="field">
            <span>File</span>
            <div
              className={`drop-zone${over ? " over" : ""}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); setFile(e.dataTransfer.files?.[0] ?? null); }}
            >
              {file ? `${file.name} · ${formatBytes(file.size)}` : "Drop an .ndjson / .jsonl file here, or click to choose"}
              <input ref={fileRef} type="file" accept=".ndjson,.jsonl,.json,.txt" style={{ display: "none" }} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
          </label>
        </div>
        {!file && (
          <label className="field">
            <span>Or paste records</span>
            <div className="editor-wrap"><CodeEditor value={payload} language="json" minRows={5} onChange={setPayload} /></div>
          </label>
        )}
        <div className="actions">
          <button className="btn primary" disabled={busy || !name} onClick={ingest}>
            {busy ? "Streaming…" : "Ingest"}
          </button>
          {file && <button className="btn ghost" onClick={() => setFile(null)}>Clear file</button>}
        </div>
      </div>
    </div>
  );
}

// ── connectors ───────────────────────────────────────────────────────
function Connectors({ connectors, onChange }: { connectors: Connector[]; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ConnectorKind>("postgres");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    try {
      await api.post("/api/connectors", { name, kind, url });
      setName("");
      setUrl("");
      setAdding(false);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2><Plugs size={15} /> Connectors</h2>
        <button className="btn sm ghost" onClick={() => setAdding((a) => !a)}><Plus size={12} /> Add</button>
      </div>
      {connectors.length === 0 && !adding && (
        <div className="empty" style={{ padding: 16 }}><div className="hint">Query external Postgres, ClickHouse, or chDB through the same API.</div></div>
      )}
      {connectors.map((c) => (
        <div key={c.name} className="ds-item" style={{ cursor: "default" }}>
          <span className="ico"><Plugs size={14} /></span>
          <div className="grow">
            <div className="t">{c.name}</div>
            <div className="s">{c.kind}{c.url ? ` · ${c.url.replace(/\/\/[^@]+@/, "//…@")}` : ""}</div>
          </div>
          <button className="btn icon sm ghost" title="Remove" onClick={async () => { await api.delete(`/api/connectors/${c.name}`); onChange(); }}><Trash size={13} /></button>
        </div>
      ))}
      {adding && (
        <div className="card-body" style={{ borderTop: "1px solid var(--border)" }}>
          {error && <Banner kind="error">{error}</Banner>}
          <label className="field"><span>Name</span><input type="text" value={name} placeholder="warehouse" onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as ConnectorKind)}>
              <option value="postgres">Postgres</option>
              <option value="clickhouse">ClickHouse</option>
              <option value="chdb">chDB (embedded)</option>
            </select>
          </label>
          {kind !== "chdb" && (
            <label className="field"><span>URL</span><input type="text" className="mono" value={url} placeholder={kind === "postgres" ? "postgres://user:pass@host:5432/db" : "http://host:8123/?user=default"} onChange={(e) => setUrl(e.target.value)} /></label>
          )}
          <div className="actions"><button className="btn primary sm" disabled={!name} onClick={add}>Add connector</button><button className="btn sm ghost" onClick={() => setAdding(false)}>Cancel</button></div>
        </div>
      )}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────
export default function Data() {
  const [params, setParams] = useSearchParams();
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [profile, setProfile] = useState<DatasetProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "query" | "ingest">((params.get("tab") as "query" | "ingest") ?? "overview");
  const [filter, setFilter] = useState("");
  const [querySql, setQuerySql] = useState<string | undefined>();
  const [confirm, confirmDialog] = useConfirm();
  const toast = useToast();
  const selected = params.get("dataset");
  useCrumbs([{ label: "Data" }, ...(selected ? [{ label: selected }] : [])]);

  const refresh = useCallback(() => {
    api.get<Dataset[]>("/api/datasets").then(setDatasets).catch(() => setDatasets([]));
    api.get<Connector[]>("/api/connectors").then(setConnectors).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  useEvents((ev) => {
    if (ev.type === "ingested") {
      refresh();
      if (ev.dataset === selected) loadProfile(selected);
    }
  });

  const loadProfile = useCallback((name: string) => {
    setProfile(null);
    setProfileError(null);
    api
      .get<DatasetProfile>(`/api/datasets/${encodeURIComponent(name)}?sample=50`)
      .then(setProfile)
      .catch((e) => setProfileError((e as Error).message));
  }, []);

  useEffect(() => {
    if (selected) loadProfile(selected);
    else setProfile(null);
  }, [selected, loadProfile]);

  // Auto-select the first dataset.
  useEffect(() => {
    if (!selected && datasets && datasets.length && tab === "overview") setParams({ dataset: datasets[0].name }, { replace: true });
  }, [datasets, selected, setParams, tab]);

  const select = (name: string) => {
    setParams({ dataset: name });
    if (tab === "ingest") setTab("overview");
  };

  const remove = async () => {
    if (!selected) return;
    if (!(await confirm({ title: `Delete dataset “${selected}”?`, body: "The NDJSON file and its registration are removed. Workflows triggered by it will no longer fire.", confirmLabel: "Delete dataset" }))) return;
    await api.delete(`/api/datasets/${encodeURIComponent(selected)}`);
    toast(`Deleted ${selected}`);
    setParams({});
    refresh();
  };

  const visible = useMemo(() => (datasets ?? []).filter((d) => d.name.toLowerCase().includes(filter.toLowerCase())), [datasets, filter]);
  const totals = useMemo(() => (datasets ?? []).reduce((a, d) => ({ records: a.records + d.records, bytes: a.bytes + d.bytes }), { records: 0, bytes: 0 }), [datasets]);
  const current = datasets?.find((d) => d.name === selected);

  return (
    <div className="content wide">
      {confirmDialog}
      <div className="page-head">
        <div>
          <h1>Data</h1>
          <p>
            {datasets ? `${datasets.length} dataset${datasets.length === 1 ? "" : "s"} · ${formatNumber(totals.records)} records · ${formatBytes(totals.bytes)}` : "Loading…"} · queried in-process by Polars
          </p>
        </div>
        <div className="actions">
          <button className={`btn${tab === "query" ? " primary" : ""}`} onClick={() => setTab("query")}><Play size={13} /> SQL workbench</button>
          <button className={`btn${tab === "ingest" ? " primary" : ""}`} onClick={() => setTab("ingest")}><UploadSimple size={14} /> Ingest</button>
        </div>
      </div>

      <div className="split" style={{ gridTemplateColumns: "280px minmax(0, 1fr)" }}>
        <div>
          <div className="card">
            <div className="card-head" style={{ padding: "8px 10px" }}>
              <input type="search" placeholder="Filter datasets" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ height: 28, fontSize: 12.5 }} />
            </div>
            {datasets === null ? (
              <div style={{ padding: 12 }}><Skeleton h={14} /><Skeleton h={14} style={{ marginTop: 8 }} /></div>
            ) : visible.length === 0 ? (
              <div className="empty" style={{ padding: 20 }}>
                <div className="title" style={{ fontSize: 13 }}>{datasets.length ? "No match" : "No datasets"}</div>
                <div className="hint">Ingest NDJSON here or POST to /api/ingest/{"{dataset}"}.</div>
              </div>
            ) : (
              <div className="ds-list">
                {visible.map((d) => (
                  <div key={d.name} className={`ds-item${selected === d.name ? " on" : ""}`} onClick={() => select(d.name)}>
                    <span className="ico"><Database size={13} /></span>
                    <div className="grow">
                      <div className="t">{d.name}</div>
                      <div className="s">{formatNumber(d.records)} rows · {formatBytes(d.bytes)} · {timeAgo(d.updated_at)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <Connectors connectors={connectors} onChange={refresh} />
        </div>

        <div>
          {tab === "ingest" ? (
            <IngestPanel defaultName={selected ?? undefined} onDone={(n) => { refresh(); setParams({ dataset: n }); setTab("overview"); }} />
          ) : tab === "query" ? (
            <Workbench datasets={datasets ?? []} connectors={connectors} selected={selected} profile={profile} initialSql={querySql} />
          ) : !selected ? (
            <div className="card"><Empty icon={<Database size={20} />} title="Pick a dataset" hint="Column profiles, sample rows, and quick queries appear here." action={<button className="btn primary sm" onClick={() => setTab("ingest")}>Ingest data</button>} /></div>
          ) : (
            <>
              <div className="card">
                <div className="card-head">
                  <h2>
                    {selected}
                    <span className="sub">{current ? `${current.records.toLocaleString()} rows · ${formatBytes(current.bytes)} · updated ${timeAgo(current.updated_at)}` : ""}</span>
                  </h2>
                  <div className="actions">
                    <button className="btn sm" onClick={() => { setQuerySql(`SELECT *\nFROM ${table(selected)}\nLIMIT 100`); setTab("query"); }}><Play size={12} /> Query</button>
                    <button className="btn sm" onClick={() => setTab("ingest")}><UploadSimple size={12} /> Append</button>
                    <button className="btn sm danger" onClick={remove}><Trash size={12} /> Delete</button>
                  </div>
                </div>
                {profileError ? (
                  <div className="card-body"><Banner kind="error">{profileError}</Banner></div>
                ) : !profile ? (
                  <div style={{ padding: 16 }}><Skeleton h={12} /><Skeleton h={12} w="70%" style={{ marginTop: 8 }} /><Skeleton h={12} w="50%" style={{ marginTop: 8 }} /></div>
                ) : profile.columns.length === 0 ? (
                  <Empty title="No columns inferred" hint="The dataset file is empty or unreadable." />
                ) : (
                  <div className="schema-list">
                    <div className="schema-row" style={{ cursor: "default", color: "var(--ink-3)", fontSize: 11 }}>
                      <span>column</span><span>type</span><span>range · mean · distinct</span><span style={{ textAlign: "right" }}>nulls</span>
                    </div>
                    {profile.columns.map((c) => {
                      const nullPct = current && current.records ? (c.null_count / current.records) * 100 : 0;
                      return (
                        <div key={c.name} className="schema-row" onClick={() => { setQuerySql(`SELECT ${c.name}, COUNT(*) AS n\nFROM ${table(selected)}\nGROUP BY ${c.name}\nORDER BY n DESC\nLIMIT 50`); setTab("query"); }} title="Group by this column in the workbench">
                          <span className="c"><TypeIcon type={dtypeToCol(c.dtype)} /> {c.name}</span>
                          <span className="ty">{c.dtype}</span>
                          <span className="rng">
                            {fmtBound(c.min)}{c.min !== null && c.min !== undefined ? ` → ${fmtBound(c.max)}` : ""}
                            {typeof c.mean === "number" ? ` · mean ${formatNumber(c.mean)}` : ""}
                            {typeof c.distinct === "number" ? ` · ${c.distinct.toLocaleString()} distinct` : ""}
                          </span>
                          <span className={`nul${c.null_count ? " has" : ""}`}>{c.null_count ? `${nullPct < 1 ? "<1" : Math.round(nullPct)}%` : "0"}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {profile && profile.sample.length > 0 && (
                <div className="section">
                  <div className="toolbar" style={{ marginBottom: 8 }}>
                    <span className="small muted">Sample of the first {profile.sample_size} rows</span>
                    <span className="grow" />
                    <button className="btn sm ghost" onClick={() => { setQuerySql(`SELECT *\nFROM ${table(selected)}\nLIMIT 1000`); setTab("query"); }}>Open in workbench <ArrowRight size={12} /></button>
                  </div>
                  <DataGrid rows={profile.sample} filename={selected} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
