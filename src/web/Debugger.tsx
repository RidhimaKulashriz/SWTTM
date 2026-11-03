"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { diffRuns, type DiffResult } from "../core/diff";
import type { Manifest, Snapshot } from "../core/types";
import { DiffView, JsonView, TimelineScrubber } from "./components";
import { demo, type Ledger, type RunData } from "./demo";

type Row = { path: string; value: string };
type Tab = "Input" | "Resolved input" | "Output" | "Error" | "Context after" | "Raw";
type GitHubStatus = { ready: boolean; repository: string | null };
const TABS: Tab[] = ["Input", "Resolved input", "Output", "Error", "Context after", "Raw"];

function paths(v: unknown, prefix = ""): string[] {
  const out: string[] = [];
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.push(p, ...paths(val, p));
    }
  }
  return out;
}

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T }> {
  const r = await fetch(url, { cache: "no-store", ...init });
  const body = (await r.json().catch(() => ({}))) as T;
  return { ok: r.ok, status: r.status, body };
}

export default function Debugger({ initialRun, initialStep }: { initialRun?: string; initialStep?: number }) {
  const [loading, setLoading] = useState(true);
  const [apiUp, setApiUp] = useState(false);
  const [live, setLive] = useState(false);
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [runs, setRuns] = useState<Manifest[]>([]);
  const [runId, setRunId] = useState<string | undefined>(initialRun);
  const [data, setData] = useState<RunData | null>(null);
  const [step, setStep] = useState(initialStep ?? 0);
  const [tab, setTab] = useState<Tab>("Output");
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");
  const [ledger, setLedger] = useState<{ ledger: Ledger; static: boolean; mock?: boolean } | null>(null);
  const [github, setGitHub] = useState<GitHubStatus>({ ready: false, repository: null });
  const [needsAuth, setNeedsAuth] = useState(false);
  const [issueTitle, setIssueTitle] = useState("Issue created by swy-tm live execution");
  const [issueLabel, setIssueLabel] = useState("bug");
  const [finalState, setFinalState] = useState<"open" | "closed">("closed");
  const [diff, setDiff] = useState<DiffResult | null>(null);

  const [from, setFrom] = useState(0);
  const [rows, setRows] = useState<Row[]>([{ path: "", value: "" }]);
  const [compensate, setCompensate] = useState(false);
  const [allowDup, setAllowDup] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<Snapshot[]>([]);
  const [guard, setGuard] = useState<{ message: string; guarded: string[] } | null>(null);
  const [error, setError] = useState("");
  const search = useRef<HTMLInputElement>(null);

  const say = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 2600);
  };

  /* ---- load runs (live API, else bundled static demo) ---- */
  const loadRuns = useCallback(async (select?: string) => {
    try {
      const r = await api<{ runs: Manifest[]; workflows: string[] }>("/api/runs");
      if (!r.ok && [401, 403, 503].includes(r.status)) {
        setApiUp(true);
        setNeedsAuth(r.status === 401 || r.status === 403);
        setLive(false);
        setRuns(demo.runs.map((x) => x.manifest));
        const preview = demo.runs.find((x) => x.manifest.runId === (select ?? initialRun)) ?? demo.runs[0];
        setRunId(preview?.manifest.runId);
        setData(preview ?? null);
        setLoading(false);
        return;
      }
      if (!r.ok) throw new Error("api");
      setApiUp(true);
      setNeedsAuth(false);
      setWorkflows(r.body.workflows);
      if (r.body.runs.length) {
        setLive(true);
        setRuns(r.body.runs);
        setRunId((cur) => select ?? (cur && r.body.runs.some((x) => x.runId === cur) ? cur : r.body.runs[0].runId));
      } else {
        setLive(false);
        setRuns(demo.runs.map((x) => x.manifest));
        const preview = demo.runs.find((x) => x.manifest.runId === (select ?? initialRun)) ?? demo.runs[0];
        setRunId(preview?.manifest.runId);
        setData(preview ?? null);
      }
    } catch (e) {
      setLive(false);
      setApiUp(false);
      setRuns(demo.runs.map((x) => x.manifest));
      const preview = demo.runs.find((x) => x.manifest.runId === (select ?? initialRun)) ?? demo.runs[0];
      setRunId((cur) => select ?? (cur && demo.runs.some((x) => x.manifest.runId === cur) ? cur : preview?.manifest.runId));
      setData(preview ?? null);
    }
    setLoading(false);
  }, [initialRun]);

  const loadLedger = useCallback(async (isLive: boolean) => {
    if (!isLive) return setLedger({ ledger: demo.ledger, static: true, mock: true });
    const r = await api<{ ledger: Ledger; mock: boolean }>("/api/ledger");
    if (r.ok) setLedger({ ledger: r.body.ledger, static: false, mock: r.body.mock });
    else setError("Live ledger could not be loaded from the backend.");
  }, []);

  useEffect(() => {
    queueMicrotask(() => void loadRuns());
  }, [loadRuns]);

  useEffect(() => {
    let cancelled = false;
    api<{ github?: GitHubStatus }>("/api/health").then((r) => {
      if (!cancelled && r.ok && r.body.github) setGitHub(r.body.github);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    queueMicrotask(() => void loadLedger(live));
  }, [live, loadLedger]);

  /* ---- load selected run ---- */
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    if (!live) return;
    (async () => {
      const r = await api<RunData>(`/api/runs/${encodeURIComponent(runId)}`);
      const d = r.ok ? r.body : null;
      if (!r.ok) setError(`Could not load live run ${runId}`);
      if (cancelled || !d) return;
      setData(d);
      setError("");
      const m = d.manifest;
      setFrom(m.failedStep ?? 0);
      setStep((s) => Math.min(s, m.steps.length - 1));
      // divergence vs parent
      if (m.parentRunId) {
        if (live) {
          const r = await api<DiffResult>(`/api/diff?a=${m.parentRunId}&b=${m.runId}`);
          if (!cancelled && r.ok) setDiff(r.body);
        } else {
          const p = demo.runs.find((x) => x.manifest.runId === m.parentRunId);
          if (p) setDiff(diffRuns({ runId: p.manifest.runId, steps: p.snapshots }, { runId: m.runId, steps: d.snapshots }));
        }
      } else setDiff(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, live]);

  /* ---- URL persistence ---- */
  useEffect(() => {
    if (!runId) return;
    window.history.replaceState(null, "", `/app?run=${encodeURIComponent(runId)}&step=${step}`);
  }, [runId, step]);

  const main = useMemo(() => (data ? data.snapshots.filter((s) => !s.stepId.endsWith(":compensate")) : []), [data]);
  const snap = main[step];

  /* ---- keyboard ---- */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/INPUT|SELECT|TEXTAREA/.test(t.tagName)) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setStep((s) => Math.min(main.length - 1, s + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setStep((s) => Math.max(0, s - 1));
      } else if (e.key === "/") {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [main.length]);

  /* ---- override validation / autocomplete ---- */
  const validPaths = useMemo(() => {
    if (!data) return new Set<string>();
    const m = data.manifest;
    const s = new Set<string>(paths(m.inputs, "inputs"));
    m.workflow.steps.forEach((st, i) => {
      if (i >= from) paths(st.input, `steps.${st.id}.input`).forEach((p) => s.add(p));
    });
    return s;
  }, [data, from]);
  const rowOk = (r: Row) => !r.path || validPaths.has(r.path);
  const setStrings = rows.filter((r) => r.path && r.value !== "").map((r) => `${r.path}=${r.value}`);
  const formValid = rows.every(rowOk);

  /* ---- streaming run/replay ---- */
  const stream = async (start: (streamId: string) => Promise<void>) => {
    setBusy(true);
    setEvents([]);
    setGuard(null);
    setError("");
    const streamId = `s_${Math.random().toString(36).slice(2, 10)}`;
    const es = new EventSource(`/api/stream/${streamId}`);
    es.addEventListener("step", (ev) => setEvents((x) => [...x, JSON.parse((ev as MessageEvent).data) as Snapshot]));
    es.addEventListener("done", () => es.close());
    es.onerror = () => es.close();
    try {
      await start(streamId);
    } finally {
      setTimeout(() => es.close(), 500);
      setBusy(false);
    }
  };

  const runWorkflow = (name: string) =>
    stream(async (streamId) => {
      const r = await api<{ runId: string; error?: string }>("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: name, executor: "mock", set: [], streamId }),
      });
      if (!r.ok) return setError(r.body.error ?? "Run failed");
      say(`Mock demo run ${r.body.runId} created`);
      setLive(true);
      await loadRuns(r.body.runId);
      setStep(0);
      loadLedger(true);
    });

  const runGitHubWorkflow = () =>
    stream(async (streamId) => {
      const [owner, repo] = github.repository?.split("/") ?? ["", ""];
      const set = Object.entries({ owner, repo, title: issueTitle.trim(), label: issueLabel.trim(), finalState }).map(
        ([key, value]) => `inputs.${key}=${JSON.stringify(value)}`,
      );
      const r = await api<{ runId: string; error?: string }>("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: "github-issue", executor: "github", set, streamId }),
      });
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) setNeedsAuth(true);
        return setError(r.body.error ?? "Live GitHub run failed");
      }
      setError("");
      say(`Live GitHub run ${r.body.runId} saved with step snapshots`);
      setLive(true);
      await loadRuns(r.body.runId);
      setStep(0);
      loadLedger(true);
    });

  const replay = (forceCompensate = false) =>
    stream(async (streamId) => {
      if (!data) return;
      const r = await api<{ runId: string; diff: DiffResult; error?: string; details?: { guarded?: string[]; missingCompensate?: string[] } }>(
        `/api/runs/${encodeURIComponent(data.manifest.runId)}/replay`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fromStep: from, set: setStrings, compensate: compensate || forceCompensate, allowDuplicate: allowDup, dryRun, streamId }),
        },
      );
      if (r.status === 409) return setGuard({ message: r.body.error ?? "Guard abort", guarded: r.body.details?.guarded ?? [] });
      if (!r.ok) return setError(r.body.error ?? "Replay failed");
      say(`Replay ${r.body.runId} complete`);
      setDiff(r.body.diff);
      await loadRuns(r.body.runId);
      setStep(from);
      loadLedger(true);
    });

  const verify = async () => {
    if (!runId || !live) return;
    const r = await api<{ ok: boolean; checked: number; reason?: string }>(`/api/runs/${runId}/verify`, { method: "POST" });
    say(r.body.ok ? `Hash chain OK (${r.body.checked} snapshots)` : `Chain BROKEN: ${r.body.reason}`);
  };

  const tabValue = (s: Snapshot): unknown =>
    ({ Input: s.input, "Resolved input": s.resolvedInput, Output: s.output, Error: s.error, "Context after": s.contextAfter, Raw: s })[tab];

  const m = data?.manifest;
  const executorLabel = !live ? "SAMPLE PREVIEW" : m?.executor === "github" ? "GITHUB LIVE" : m?.mock ? "MOCK DEMO" : "SWYTCHCODE";

  return (
    <div className="dbg">
      <div className="top">
        <Link href="/" className="mono" style={{ marginRight: 8 }}>← swy-tm</Link>
        <label className="sr" htmlFor="runsel">Run</label>
        <select id="runsel" value={runId ?? ""} onChange={(e) => {
          const selected = e.target.value;
          setRunId(selected);
          setStep(0);
          if (!live) {
            const preview = demo.runs.find((x) => x.manifest.runId === selected) ?? null;
            setData(preview);
            setDiff(null);
            setFrom(preview?.manifest.failedStep ?? 0);
          }
        }} disabled={!runs.length}>
          {runs.map((r) => (
            <option key={r.runId} value={r.runId}>
              {r.runId} · {r.workflowId} · {r.outcome}{r.parentRunId ? ` ← ${r.parentRunId}` : ""}
            </option>
          ))}
        </select>
        {m && <span className={`badge ${m.executor === "github" ? "real" : "mock"}`} title={!live ? "Bundled sample snapshots; no live run has been selected." : undefined}>{executorLabel}</span>}
        <span style={{ flex: 1 }} />
        {!github.ready && <button className="btn sm" disabled={!apiUp || busy} onClick={() => runWorkflow("demo-tracker")}>Run mock demo</button>}
        <button className="btn sm ghost" disabled={!live || busy || !data} onClick={() => replay()}>
          Replay from step {from}
        </button>
        <button className="btn sm ghost" disabled={!live || !data} onClick={verify}>
          Verify chain
        </button>
      </div>
      {!loading ? (
        <div className="banner" role="status">
          {needsAuth ? "LIVE API CONNECTED — sign in to view private GitHub runs; bundled sample preview shown." : apiUp ? "LIVE API CONNECTED — bundled samples are previews; saved runs load from the backend." : "API UNREACHABLE — showing bundled sample snapshots. Start the server for live replay."}
        </div>
      ) : (
        <div />
      )}

      <section className="pane" aria-label="Live GitHub workflow" style={{ margin: "12px 0" }}>
        <div className="label">LIVE GITHUB ISSUE WORKFLOW</div>
        <p className="label" style={{ margin: "8px 0" }}>
          {github.ready
            ? `Real side effects in ${github.repository}: create an issue, apply the label, then set its state.`
            : "Live execution is not configured. Add the server-side GitHub, Neon Auth, allowed-email, and PostgreSQL settings described in README."}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}>
          <label style={{ flex: "2 1 240px" }}>Issue title<input aria-label="GitHub issue title" value={issueTitle} onChange={(e) => setIssueTitle(e.target.value)} /></label>
          <label style={{ flex: "1 1 120px" }}>Label<input aria-label="GitHub issue label" value={issueLabel} onChange={(e) => setIssueLabel(e.target.value)} /></label>
          <label>Final state<select aria-label="GitHub issue final state" value={finalState} onChange={(e) => setFinalState(e.target.value as "open" | "closed")}><option value="open">open</option><option value="closed">closed</option></select></label>
          <button className="btn" disabled={!github.ready || busy || !issueTitle.trim() || !issueLabel.trim()} onClick={runGitHubWorkflow}>
            {busy ? "Running…" : "Run live GitHub workflow"}
          </button>
          {(needsAuth || github.ready) && <Link href="/auth/sign-in" className="btn ghost">Sign in</Link>}
        </div>
        {error && <p className="warn" role="alert" style={{ marginTop: 10 }}>{error}</p>}
      </section>

      <div className="panes">
        {/* ---- timeline ---- */}
        <section className="pane" aria-label="Timeline">
          <div className="label" style={{ marginBottom: 8 }}>
            Timeline {m ? `· ${m.workflowId}` : ""}{data ? ` · ${data.snapshots.length} snapshots` : ""}
          </div>
          {loading && <div className="label caret">Loading runs</div>}
          {!loading && data && !data.snapshots.length && <div className="label">No snapshots yet. Run a workflow.</div>}
          <div role="listbox" aria-label="Steps" aria-activedescendant={main[step] ? `st-${step}` : undefined}>
            {data?.snapshots.map((s) => {
              const compensation = s.stepId.endsWith(":compensate");
              const mainIndex = main.indexOf(s);
              return (
                <button
                  key={s.seq}
                  id={compensation ? undefined : `st-${mainIndex}`}
                  role="option"
                  aria-selected={!compensation && mainIndex === step}
                  className="step"
                  style={compensation ? { opacity: 0.8 } : undefined}
                  onClick={() => { if (!compensation) setStep(mainIndex); }}
                >
                  <span className={`dot ${s.status}`} title={s.status} />
                  <span className="sbody">
                    <span className="srow">
                      <span className="mono">{compensation ? "↩ " : `${String(mainIndex).padStart(2, "0")} `}{s.stepId}</span>
                      <span className="label">{s.durationMs}ms</span>
                    </span>
                    <span className="smeta">
                      <span className="label">{s.status}</span>
                      {s.sideEffect && <span className="label">⚡ side-effect</span>}
                      <span className="label">#{s.hash.slice(0, 8)}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {main.length > 0 && <TimelineScrubber steps={main.map((s) => ({ id: s.stepId, status: s.status }))} value={step} onChange={(v) => setStep(Math.round(v))} onCommit={setStep} />}
          <div className="label" style={{ marginTop: 16 }}>Side-effect ledger {ledger?.static ? "(bundled sample preview)" : ledger?.mock ? "(live mock demo)" : "(live GitHub activity)"}</div>
          {ledger && (
            <div className="kv" data-testid="ledger" style={{ marginTop: 6 }}>
              <span>created</span><b data-testid="ledger-created">{ledger.ledger.created}</b>
              <span>deleted</span><b data-testid="ledger-deleted">{ledger.ledger.deleted}</b>
              <span>labeled</span><b>{ledger.ledger.labeled}</b>
              <span>updated</span><b>{ledger.ledger.updated}</b>
            </div>
          )}
        </section>

        {/* ---- inspector ---- */}
        <section className="pane" aria-label="Inspector">
          {error && <div className="warn" role="alert">{error}</div>}
          {snap ? (
            <>
              <div className="kv">
                <span className="label">step</span><span>{snap.stepIndex} · {snap.stepId}</span>
                <span className="label">canonicalId</span><span>{snap.canonicalId}</span>
                <span className="label">status</span><span style={{ color: snap.status === "error" ? "var(--alert)" : undefined }}>{snap.status}</span>
                <span className="label">sideEffect</span><span>{String(snap.sideEffect)}</span>
                <span className="label">executor</span><span>{!live ? "bundled sample preview" : snap.executor === "github" ? "GitHub live" : snap.mock ? "mock demo" : snap.executor}</span>
                <span className="label">hash</span><span style={{ wordBreak: "break-all" }}>{snap.hash}</span>
                <span className="label">prevHash</span><span style={{ wordBreak: "break-all" }}>{snap.prevHash ?? "null"}</span>
              </div>
              <div className="tabs" role="tablist" aria-label="Inspector tabs">
                {TABS.map((t) => (
                  <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>
                ))}
              </div>
              <div className="tabs">
                <input ref={search} type="text" placeholder="/ search" aria-label="Search JSON" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginLeft: "auto", width: 140 }} />
                <button onClick={async () => { await navigator.clipboard?.writeText(JSON.stringify(tabValue(snap), null, 2) ?? "").catch(() => {}); say("Copied"); }}>copy</button>
              </div>
              <div className="json" data-testid="json">
                <JsonView value={tabValue(snap)} query={query} />
              </div>
            </>
          ) : (
            !loading && <div className="label">Select a step.</div>
          )}
        </section>

        {/* ---- replay ---- */}
        <section className="pane" aria-label="Replay panel">
          <div className="label" style={{ marginBottom: 8 }}>Replay</div>
          <label className="label" htmlFor="from">Replay from step</label>
          <select id="from" value={from} onChange={(e) => setFrom(Number(e.target.value))} style={{ width: "100%", margin: "4px 0 12px" }} disabled={!m}>
            {m?.steps.map((s) => (
              <option key={s.id} value={s.index}>{s.index} · {s.id}</option>
            ))}
          </select>
          <div className="label">Overrides (path = value)</div>
          <datalist id="paths">{[...validPaths].map((p) => <option key={p} value={p} />)}</datalist>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 6, margin: "6px 0" }}>
              <input list="paths" aria-label={`Override path ${i + 1}`} aria-invalid={!rowOk(r)} placeholder="inputs.finalState" value={r.path} style={{ flex: 2, borderColor: rowOk(r) ? undefined : "var(--alert)" }} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, path: e.target.value } : y)))} />
              <input aria-label={`Override value ${i + 1}`} placeholder="closed" value={r.value} style={{ flex: 1 }} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))} />
              <button className="chipf" aria-label={`Remove override ${i + 1}`} onClick={() => setRows((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : [{ path: "", value: "" }]))}>×</button>
            </div>
          ))}
          {!formValid && <div className="label red" role="alert">Unknown override path — pick one from the list.</div>}
          <button className="chipf" onClick={() => setRows((x) => [...x, { path: "", value: "" }])}>+ add override</button>
          <div style={{ display: "grid", gap: 6, margin: "14px 0" }}>
            <label><input type="checkbox" checked={compensate} onChange={(e) => setCompensate(e.target.checked)} /> Compensate</label>
            <label><input type="checkbox" checked={allowDup} onChange={(e) => setAllowDup(e.target.checked)} /> Allow duplicate</label>
            <label><input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Dry run</label>
          </div>
          <button className="btn" disabled={!live || busy || !formValid || !data} onClick={() => replay()} style={{ width: "100%", justifyContent: "center" }}>
            {busy ? "Replaying…" : "Replay"}
          </button>
          {!live && <div className="label" style={{ marginTop: 8 }}>Replay needs live runs (run `swy-tm serve`, then RUN WORKFLOW).</div>}

          {guard && (
            <div className="warn" role="alert" data-testid="guard">
              <div className="mono red">Side-effect guard · 409</div>
              <p style={{ margin: "8px 0" }}>Replaying would repeat real effects of: {guard.guarded.join(", ") || "(see message)"}. Nothing was executed.</p>
              <button className="btn sm red" onClick={() => { setCompensate(true); replay(true); }}>Retry with compensate</button>
            </div>
          )}

          <div aria-live="polite" data-testid="stream" style={{ marginTop: 16 }}>
            {events.map((e) => (
              <div key={e.seq} className="mono label" style={{ padding: "2px 0" }}>
                <span className={`dot ${e.status}`} style={{ display: "inline-block", marginRight: 8 }} />
                {e.stepId} → {e.status}
              </div>
            ))}
            {busy && <div className="mono label caret">running</div>}
          </div>
        </section>
      </div>

      <div className="drawer" aria-label="Divergence">
        {diff ? <DiffView diff={diff} onJump={(i) => setStep(i)} /> : <div className="label">Divergence — select a replayed run (one with a parent) or run a replay to see the diff.</div>}
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
