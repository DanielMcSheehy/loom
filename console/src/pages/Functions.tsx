// Functions: list on the left, playground on the right (code, params,
// invoke, result, session history).
import { Function as FunctionIcon, PencilSimple, Play, Plus, Trash } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, timeAgo, useEvents } from "../api";
import { useCrumbs } from "../App";
import CodeEditor, { CodeBlock } from "../components/CodeEditor";
import ResultView from "../components/ResultView";
import { Banner, Empty, RuntimeBadge, useConfirm, useToast } from "../components/ui";
import type { LoomFunction, RuntimeName } from "../types";

const TEMPLATES: Record<RuntimeName, string> = {
  python: `def handler(params, inputs):\n    name = params.get("name", "world")\n    return {"greeting": f"hello {name}"}\n`,
  typescript: `export function handler(params: { name?: string }) {\n  return { greeting: \`hello \${params.name ?? "world"}\` };\n}\n`,
  javascript: `export function handler(params) {\n  return { greeting: \`hello \${params.name ?? "world"}\` };\n}\n`,
};

interface InvokeResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  logs?: string[];
  duration_ms: number;
  at: string;
  params: string;
}

export default function Functions() {
  const [functions, setFunctions] = useState<LoomFunction[] | null>(null);
  const [params, setParams] = useSearchParams();
  const creating = params.get("new") === "1";
  const selectedName = params.get("name");
  const [name, setName] = useState("hello");
  const [runtime, setRuntime] = useState<RuntimeName>("python");
  const [code, setCode] = useState(TEMPLATES.python);
  const [timeout, setTimeoutSecs] = useState(300);
  const [error, setError] = useState<string | null>(null);
  const [invokeParams, setInvokeParams] = useState('{"name": "loom"}');
  const [history, setHistory] = useState<Record<string, InvokeResult[]>>({});
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editCode, setEditCode] = useState("");
  const [editRuntime, setEditRuntime] = useState<RuntimeName>("python");
  const [confirm, confirmDialog] = useConfirm();
  const toast = useToast();
  useCrumbs([{ label: "Functions" }, ...(selectedName ? [{ label: selectedName }] : [])]);

  const refresh = useCallback(() => {
    api.get<LoomFunction[]>("/api/functions").then(setFunctions).catch(() => setFunctions([]));
  }, []);
  useEffect(refresh, [refresh]);
  useEvents((ev) => {
    if (ev.type === "function_invoked") refresh();
  });
  useEffect(() => {
    if (functions && functions.length && !selectedName && !creating) setParams({ name: functions[0].spec.name }, { replace: true });
  }, [functions, selectedName, creating, setParams]);

  const selected = useMemo(() => functions?.find((f) => f.spec.name === selectedName) ?? null, [functions, selectedName]);
  useEffect(() => setEditing(false), [selectedName]);

  const create = async () => {
    setError(null);
    try {
      await api.post("/api/functions", { name, runtime, code, timeout_secs: timeout });
      setParams({ name });
      refresh();
      toast(`Deployed ${name}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const invoke = async () => {
    if (!selected) return;
    setBusy(true);
    const fname = selected.spec.name;
    const at = new Date().toISOString();
    try {
      const p = invokeParams.trim() ? JSON.parse(invokeParams) : {};
      const res = await api.post<InvokeResult>(`/api/functions/${fname}/invoke`, { params: p });
      setHistory((h) => ({ ...h, [fname]: [{ ...res, at, params: invokeParams }, ...(h[fname] ?? [])].slice(0, 20) }));
    } catch (e) {
      setHistory((h) => ({ ...h, [fname]: [{ ok: false, error: (e as Error).message, duration_ms: 0, at, params: invokeParams }, ...(h[fname] ?? [])] }));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!selected) return;
    setError(null);
    try {
      await api.post("/api/functions", { name: selected.spec.name, runtime: editRuntime, code: editCode, timeout_secs: selected.spec.timeout_secs });
      setEditing(false);
      refresh();
      toast("Function updated");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!selected) return;
    if (!(await confirm({ title: `Delete function “${selected.spec.name}”?`, confirmLabel: "Delete function" }))) return;
    await api.delete(`/api/functions/${selected.spec.name}`);
    setParams({});
    refresh();
  };

  const results = selected ? history[selected.spec.name] ?? [] : [];
  const latest = results[0];

  return (
    <div className="content wide">
      {confirmDialog}
      <div className="page-head">
        <div>
          <h1>Functions</h1>
          <p>Serverless handlers in Python, TypeScript, or JavaScript. Deploy once, invoke over HTTP or from any task.</p>
        </div>
        <button className="btn primary" onClick={() => setParams(creating ? {} : { new: "1" })}>
          {creating ? "Close" : <><Plus size={14} weight="bold" /> New function</>}
        </button>
      </div>

      <div className="split" style={{ gridTemplateColumns: "260px minmax(0, 1fr)" }}>
        <div className="card">
          {functions === null ? (
            <div style={{ padding: 14 }}><div className="skeleton" style={{ height: 14 }} /></div>
          ) : functions.length === 0 ? (
            <Empty icon={<FunctionIcon size={20} />} title="No functions" hint="Deploy one here or via the SDKs." />
          ) : (
            <div className="fn-list">
              {functions.map((f) => (
                <div key={f.id} className={`fn-item${selectedName === f.spec.name && !creating ? " on" : ""}`} onClick={() => setParams({ name: f.spec.name })}>
                  <RuntimeBadge runtime={f.spec.runtime} />
                  <span className="t">{f.spec.name}</span>
                  <span className="c">{f.invocations}×</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          {creating ? (
            <div className="card">
              <div className="card-head">
                <h2>Deploy a function</h2>
                <button className="btn primary sm" onClick={create} disabled={!name}>Deploy</button>
              </div>
              <div className="card-body">
                {error && <Banner kind="error">{error}</Banner>}
                <div className="form-row">
                  <label className="field"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} /><span className="help">Invoke at POST /api/functions/{name || "{name}"}/invoke</span></label>
                  <label className="field" style={{ flex: "0 0 160px" }}><span>Runtime</span>
                    <select value={runtime} onChange={(e) => { const rt = e.target.value as RuntimeName; setRuntime(rt); if (code === TEMPLATES[runtime]) setCode(TEMPLATES[rt]); }}>
                      <option value="python">Python</option>
                      <option value="typescript">TypeScript</option>
                      <option value="javascript">JavaScript</option>
                    </select>
                  </label>
                  <label className="field" style={{ flex: "0 0 120px" }}><span>Timeout (s)</span><input type="number" value={timeout} min={1} onChange={(e) => setTimeoutSecs(Number(e.target.value))} /></label>
                </div>
                <label className="field"><span>Handler</span><div className="editor-wrap"><CodeEditor value={code} language={runtime} minRows={12} onChange={setCode} /></div></label>
              </div>
            </div>
          ) : !selected ? (
            <div className="card"><Empty icon={<FunctionIcon size={20} />} title="Select a function" hint="Its code, a playground, and invocation history appear here." /></div>
          ) : (
            <>
              <div className="card">
                <div className="card-head">
                  <h2>
                    {selected.spec.name} <RuntimeBadge runtime={selected.spec.runtime} full />
                    <span className="sub">{selected.invocations} invocation{selected.invocations === 1 ? "" : "s"} · timeout {selected.spec.timeout_secs}s · updated {timeAgo(selected.updated_at)}</span>
                  </h2>
                  <div className="actions">
                    {editing ? (
                      <>
                        <select className="inline" value={editRuntime} onChange={(e) => setEditRuntime(e.target.value as RuntimeName)}>
                          <option value="python">python</option>
                          <option value="typescript">typescript</option>
                          <option value="javascript">javascript</option>
                        </select>
                        <button className="btn sm" onClick={() => setEditing(false)}>Cancel</button>
                        <button className="btn primary sm" onClick={saveEdit}>Save</button>
                      </>
                    ) : (
                      <>
                        <button className="btn sm" onClick={() => { setEditing(true); setEditCode(selected.spec.code); setEditRuntime(selected.spec.runtime); }}><PencilSimple size={13} /> Edit code</button>
                        <button className="btn sm danger" onClick={remove}><Trash size={13} /></button>
                      </>
                    )}
                  </div>
                </div>
                {error && <div className="card-body" style={{ paddingBottom: 0 }}><Banner kind="error">{error}</Banner></div>}
                {editing ? (
                  <div className="editor-wrap"><div className="cm-host" style={{ border: "none", borderRadius: 0 }}><CodeEditor value={editCode} language={editRuntime} minRows={12} autoFocus onChange={setEditCode} /></div></div>
                ) : (
                  <CodeBlock code={selected.spec.code} language={selected.spec.runtime} className="fn-code" />
                )}
              </div>

              <div className="card">
                <div className="card-head">
                  <h2>Playground</h2>
                  <span className="sub mono">POST /api/functions/{selected.spec.name}/invoke</span>
                </div>
                <div className="card-body">
                  <label className="field">
                    <span>Params (JSON)</span>
                    <div className="editor-wrap"><CodeEditor value={invokeParams} language="json" minRows={2} lineNumbers={false} onChange={setInvokeParams} onRun={invoke} /></div>
                  </label>
                  <div className="actions">
                    <button className="btn primary" disabled={busy} onClick={invoke}><Play size={13} weight="fill" /> {busy ? "Running…" : "Invoke"}</button>
                    <span className="muted small">⌘⏎ in the editor also invokes</span>
                  </div>
                  {latest && (
                    <div style={{ marginTop: 14 }}>
                      {latest.ok ? (
                        <>
                          <div className="small muted" style={{ marginBottom: 6 }}>{latest.duration_ms}ms · {new Date(latest.at).toLocaleTimeString()}</div>
                          <ResultView value={latest.result} filename={selected.spec.name} />
                          {latest.logs && latest.logs.length > 0 && <pre className="result-json" style={{ marginTop: 8 }}>{latest.logs.join("\n")}</pre>}
                        </>
                      ) : (
                        <Banner kind="error">{latest.error}</Banner>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {results.length > 1 && (
                <div className="card">
                  <div className="card-head"><h2>This session</h2></div>
                  <div className="invoke-history">
                    {results.map((r, i) => (
                      <div key={i} className="invoke-row">
                        <span className="muted">{new Date(r.at).toLocaleTimeString()}</span>
                        <span className="mono truncate">{r.params || "{}"} → {r.ok ? JSON.stringify(r.result).slice(0, 80) : <span style={{ color: "var(--critical)" }}>{r.error}</span>}</span>
                        <span className="num muted">{r.duration_ms}ms</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
