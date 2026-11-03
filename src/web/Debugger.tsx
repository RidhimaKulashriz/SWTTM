"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { diffRuns, type DiffResult } from "../core/diff";
import type { Manifest, Snapshot } from "../core/types";
import type { ReconcileReport } from "../server/reconcile";
import { ConnectForm, Launcher, type Launch } from "./Connect";
import { DiffView, JsonView, TimelineScrubber } from "./components";
import { api, getConn, loadStoredConn, setConn, type ConnInfo } from "./connection";
import type { Ledger, RunData } from "./demo";
import { LiveCheck } from "./LiveCheck";

type Row = { path: string; value: string };
type Tab = "Input" | "Resolved input" | "Output" | "Error" | "Context after" | "Raw";
const TABS: Tab[] = ["Input", "Resolved input", "Output", "Error", "Context after", "Raw"];
type LedgerState = Ledger & { commented?: number };

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

const JSON_HEADERS = { "content-type": "application/json" };
const newestFirst = (a: Manifest, b: Manifest) => b.createdAt.localeCompare(a.createdAt);
const streamId = () => `s_${crypto.randomUUID().replace(/-/g, "")}`;
const isPlan = (o: unknown) => Boolean(o && typeof o === "object" && (o as { dryRun?: unknown }).dryRun === true);

/** Real GitHub runs are sent back with a request when the server holds no history of them (hash-verified there). */
function seedOf(d: RunData | null): { manifest: Manifest; snapshots: Snapshot[] } | undefined {
  if (!d || d.manifest.executor !== "github" || !d.manifest.workflow) return undefined;
  return { manifest: d.manifest, snapshots: d.snapshots };
}

function ledgerOf(runs: RunData[]): LedgerState {
  const l: LedgerState = { created: 0, deleted: 0, labeled: 0, unlabeled: 0, updated: 0, commented: 0 };
  for (const run of runs) {
    for (const x of run.snapshots) {
      if (x.status !== "ok" || isPlan(x.output)) continue;
      const id = x.canonicalId;
      if (id === "tracker.issue.create" || id === "github.issue.create") l.created++;
      if (id === "tracker.issue.delete" || id === "github.issue.comment.delete") l.deleted++;
      if (id === "tracker.issue.label" || id === "github.issue.labels.create") l.labeled++;
      if (id === "tracker.issue.unlabel" || id === "github.issue.labels.remove") l.unlabeled++;
      if (id === "tracker.issue.update" || id === "github.issue.update") l.updated++;
      if (id === "github.issue.comment.create") l.commented = (l.commented ?? 0) + 1;
    }
  }
  return l;
}

const DEFAULT_LAUNCH: Launch = {
  workflow: "github-issue",
  title: "Checkout page fails on submit",
  label: "bug",
  comment: "Reproduced. Investigating.",
  finalState: "closed",
  breakLast: false,
  dryRun: false,
};

export default function Debugger({ initialRun, initialStep }: { initialRun?: string; initialStep?: number }) {
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<ConnInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connError, setConnError] = useState("");
  const [dockOpen, setDockOpen] = useState(true);
  const [launch, setLaunch] = useState<Launch>(DEFAULT_LAUNCH);

  const [runs, setRuns] = useState<Manifest[]>([]);
  const [runId, setRunId] = useState<string | undefined>(initialRun);
  const [data, setData] = useState<RunData | null>(null);
  const [step, setStep] = useState(initialStep ?? 0);
  const [tab, setTab] = useState<Tab>("Output");
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");
  const [ledger, setLedger] = useState<LedgerState | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [checking, setChecking] = useState(false);

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
  /** runs held in this browser (the server keeps no history when it has no database) */
  const session = useRef<RunData[]>([]);
  /** ids the server itself can serve */
  const serverIds = useRef<Set<string>>(new Set());
  const connected = Boolean(info);
  const remember = (run: RunData | undefined) => {
    if (!run?.manifest || !Array.isArray(run.snapshots)) return;
    session.current = [run, ...session.current.filter((x) => x.manifest.runId !== run.manifest.runId)];
  };

  const say = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 3200);
  };

  /* ---- ledger of real changes this account has made ---- */
  const loadLedger = useCallback(async (isConnected: boolean) => {
    if (!isConnected) return setLedger({ created: 0, deleted: 0, labeled: 0, unlabeled: 0, updated: 0, commented: 0 });
    const extra = ledgerOf(session.current.filter((x) => !serverIds.current.has(x.manifest.runId)));
    if (serverIds.current.size === 0) return setLedger(extra);
    try {
      const r = await api<{ ledger: LedgerState }>("/api/ledger");
      if (!r.ok) return setLedger(ledgerOf(session.current));
      const l = r.body.ledger;
      setLedger({
        created: l.created + extra.created,
        deleted: l.deleted + extra.deleted,
        labeled: l.labeled + extra.labeled,
        unlabeled: l.unlabeled + extra.unlabeled,
        updated: l.updated + extra.updated,
        commented: (l.commented ?? 0) + (extra.commented ?? 0),
      });
    } catch {
      setLedger(ledgerOf(session.current));
    }
  }, []);

  /* ---- load runs: your saved history + this browser's runs, nothing at all before you connect (no sample data) ---- */
  const loadRuns = useCallback(
    async (isConnected: boolean, select?: string) => {
      if (!isConnected) {
        serverIds.current = new Set();
        setRuns([]);
        setRunId(undefined);
        setData(null);
        setFrom(0);
        setStep(0);
        setDiff(null);
        setReport(null);
        setLoading(false);
        void loadLedger(false);
        return;
      }
      let server: Manifest[] = [];
      try {
        const r = await api<{ runs: Manifest[] }>("/api/runs");
        if (r.ok && Array.isArray(r.body.runs)) server = r.body.runs;
      } catch {
        setError("Could not load your saved runs. The API may be unreachable.");
      }
      serverIds.current = new Set(server.map((x) => x.runId));
      const local = session.current.filter((x) => !serverIds.current.has(x.manifest.runId)).map((x) => x.manifest);
      const merged = [...local, ...server].sort(newestFirst);
      setRuns(merged);
      if (merged.length) setRunId((cur) => select ?? (cur && merged.some((x) => x.runId === cur) ? cur : merged[0].runId));
      else {
        setRunId(undefined);
        setData(null);
        setDiff(null);
        setReport(null);
      }
      setLoading(false);
      void loadLedger(true);
    },
    [initialRun, loadLedger],
  );

  /* ---- connection ---- */
  const adopt = useCallback(
    async (token: string, repo: string, remember: boolean) => {
      setConnecting(true);
      setConnError("");
      setConn({ token, repo }, remember);
      try {
        const r = await api<ConnInfo & { error?: string }>("/api/github/connect", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ token, repo }),
        });
        if (!r.ok) {
          setConn(null);
          setInfo(null);
          setConnError(r.body.error ?? "GitHub did not accept that connection.");
          await loadRuns(false);
          return;
        }
        session.current = [];
        setError("");
        await loadRuns(true);
        setInfo(r.body);
        setDockOpen(true);
        say(`Connected to ${r.body.repository} as @${r.body.login}`);
      } catch {
        setConn(null);
        setConnError("Could not reach the server to verify the connection.");
        await loadRuns(false);
      } finally {
        setConnecting(false);
      }
    },
    [loadRuns],
  );

  const disconnect = () => {
    setConn(null);
    setInfo(null);
    session.current = [];
    setError("");
    setGuard(null);
    setEvents([]);
    setConnError("");
    void loadRuns(false);
    say("Disconnected. Your token was removed from this browser.");
  };

  useEffect(() => {
    queueMicrotask(() => {
      const stored = loadStoredConn();
      if (stored) void adopt(stored.conn.token, stored.conn.repo, stored.remembered);
      else void loadRuns(false);
    });
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- load selected run ---- */
  useEffect(() => {
    if (!runId || !connected) return;
    let cancelled = false;
    (async () => {
      let d: RunData | null = session.current.find((x) => x.manifest.runId === runId) ?? null;
      if (!d && !serverIds.current.has(runId)) return;
      if (!d) {
        try {
          const r = await api<RunData>(`/api/runs/${encodeURIComponent(runId)}`);
          d = r.ok && r.body.manifest ? r.body : null;
          if (!r.ok) setError(`Could not load run ${runId}`);
        } catch {
          setError(`Could not load run ${runId}`);
        }
      }
      if (cancelled || !d) return;
      setData(d);
      setReport(null);
      const m = d.manifest;
      setFrom(m.failedStep ?? 0);
      setStep((st) => Math.min(st, Math.max(m.steps.length - 1, 0)));
      // when a run broke on a bad value, pre-fill the fix so it is one click away
      const fs = (m.inputs as Record<string, unknown>)?.finalState;
      if (m.outcome === "failed" && typeof fs === "string" && fs !== "open" && fs !== "closed") setRows([{ path: "inputs.finalState", value: "closed" }]);
      // divergence vs parent
      if (m.parentRunId) {
        const parent = session.current.find((x) => x.manifest.runId === m.parentRunId);
        if (parent) {
          const strip = (x: Snapshot[]) => x.filter((y) => !y.stepId.endsWith(":compensate"));
          setDiff(diffRuns({ runId: parent.manifest.runId, steps: strip(parent.snapshots) }, { runId: m.runId, steps: strip(d.snapshots) }));
        } else {
          try {
            const r = await api<DiffResult>(`/api/diff?a=${encodeURIComponent(m.parentRunId)}&b=${encodeURIComponent(m.runId)}`);
            if (!cancelled) setDiff(r.ok ? r.body : null);
          } catch {
            if (!cancelled) setDiff(null);
          }
        }
      } else setDiff(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, connected]);

  /* ---- URL persistence ---- */
  useEffect(() => {
    if (!runId) return;
    window.history.replaceState(null, "", `/app?run=${encodeURIComponent(runId)}&step=${step}`);
  }, [runId, step]);

  const main = useMemo(() => (data ? data.snapshots.filter((s) => !s.stepId.endsWith(":compensate")) : []), [data]);
  const si = Math.min(step, Math.max(main.length - 1, 0));
  const snap = main[si];

  /* ---- keyboard ---- */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/INPUT|SELECT|TEXTAREA/.test(t.tagName)) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setStep((s) => Math.max(0, Math.min(main.length - 1, s + 1)));
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
  const stream = async (start: (id: string) => Promise<void>) => {
    setBusy(true);
    setEvents([]);
    setGuard(null);
    setError("");
    const id = streamId();
    let es: EventSource | undefined;
    try {
      es = new EventSource(`/api/stream/${id}`);
      es.addEventListener("step", (ev) => setEvents((x) => [...x, JSON.parse((ev as MessageEvent).data) as Snapshot]));
      es.addEventListener("done", () => es?.close());
      es.onerror = () => es?.close();
    } catch {
      es = undefined;
    }
    try {
      await start(id);
    } catch (e) {
      setError(`Request failed: ${(e as Error).message || "the API is unreachable"}`);
    } finally {
      setTimeout(() => es?.close(), 500);
      setBusy(false);
    }
  };

  /** the live stream may be unavailable: fall back to the snapshots in the response */
  const showEvents = (snaps: Snapshot[] | undefined) => setEvents((cur) => (cur.length || !snaps ? cur : snaps));

  /* ---- live check ---- */
  const checkLive = useCallback(async (d: RunData | null, quiet = false) => {
    if (!d || !getConn()) return;
    setChecking(true);
    try {
      const known = serverIds.current.has(d.manifest.runId);
      const seed = seedOf(d);
      const r = await api<ReconcileReport & { error?: string }>(`/api/runs/${encodeURIComponent(d.manifest.runId)}/reconcile`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(!known && seed ? { seed } : {}),
      });
      if (!r.ok) {
        if (!quiet) setError(r.body.error ?? "Live check failed");
        return;
      }
      setReport(r.body);
    } catch {
      if (!quiet) setError("Live check failed: the API is unreachable.");
    } finally {
      setChecking(false);
    }
  }, []);

  const finish = async (r: { runId: string; manifest?: Manifest; snapshots?: Snapshot[] }, message: string) => {
    let fresh: RunData | null = null;
    if (r.manifest && r.snapshots) {
      fresh = { manifest: r.manifest, snapshots: r.snapshots };
      remember(fresh);
    }
    showEvents(r.snapshots);
    say(message);
    await loadRuns(true, r.runId);
    void loadLedger(true);
    if (fresh && !fresh.snapshots.some((s) => isPlan(s.output))) void checkLive(fresh, true);
  };

  const runWorkflow = () =>
    stream(async (sid) => {
      if (!info) return;
      const [owner, repo] = info.repository.split("/");
      const values: Record<string, string> = {
        owner,
        repo,
        title: launch.title.trim(),
        label: launch.label.trim(),
        finalState: launch.breakLast ? "pending" : launch.finalState,
      };
      if (launch.workflow === "github-triage") values.comment = launch.comment.trim();
      const set = Object.entries(values).map(([k, v]) => `inputs.${k}=${JSON.stringify(v)}`);
      const r = await api<{ runId: string; outcome?: string; error?: string; manifest?: Manifest; snapshots?: Snapshot[] }>("/api/runs", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ workflow: launch.workflow, executor: "github", set, dryRun: launch.dryRun, streamId: sid }),
      });
      if (!r.ok) return setError(r.body.error ?? "The run failed to start");
      const failed = r.body.outcome === "failed";
      await finish(
        r.body,
        launch.dryRun ? `Plan ${r.body.runId} recorded — nothing was sent to GitHub` : failed ? `Run ${r.body.runId} stopped at a failing step. Real changes before it are on GitHub.` : `Run ${r.body.runId} completed on GitHub`,
      );
      setStep(failed ? (r.body.manifest?.failedStep ?? 0) : 0);
    });

  const replay = (forceCompensate = false) =>
    stream(async (sid) => {
      if (!data || !connected) return;
      const parent = data;
      const known = serverIds.current.has(parent.manifest.runId);
      const seed = seedOf(parent);
      type ReplayResp = {
        runId: string;
        diff: DiffResult;
        error?: string;
        manifest?: Manifest;
        snapshots?: Snapshot[];
        executorCalls?: number;
        injected?: number;
        details?: { guarded?: string[]; missingCompensate?: string[] };
      };
      const call = (withSeed: boolean) =>
        api<ReplayResp>(`/api/runs/${encodeURIComponent(parent.manifest.runId)}/replay`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ fromStep: from, set: setStrings, compensate: compensate || forceCompensate, allowDuplicate: allowDup, dryRun, streamId: sid, ...(withSeed && seed ? { seed } : {}) }),
        });
      let usedSeed = !known;
      let r = await call(usedSeed);
      if (r.status === 404 && seed && !usedSeed) {
        usedSeed = true;
        r = await call(true);
      }
      if (r.status === 409) return setGuard({ message: r.body.error ?? "Guard abort", guarded: r.body.details?.guarded ?? [] });
      if (!r.ok) return setError(r.body.error ?? "Replay failed");
      if (usedSeed) remember(parent);
      setDiff(r.body.diff);
      await finish(
        r.body,
        dryRun
          ? `Plan ${r.body.runId} recorded — nothing was sent to GitHub`
          : `Replay ${r.body.runId}: ${r.body.executorCalls ?? 0} GitHub call(s), ${r.body.injected ?? 0} step(s) reused from the recording`,
      );
      setStep(from);
    });

  const verify = async () => {
    if (!runId || !data) return;
    const known = serverIds.current.has(runId);
    const seed = data.manifest.workflow ? { manifest: data.manifest, snapshots: data.snapshots } : undefined;
    type VerifyResp = { ok: boolean; checked: number; reason?: string; error?: string };
    const call = (withSeed: boolean) =>
      api<VerifyResp>(`/api/runs/${encodeURIComponent(runId)}/verify`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(withSeed && seed ? { seed } : {}),
      });
    try {
      let r = await call(!known && connected ? true : !connected);
      if (r.status === 404 && seed) r = await call(true);
      if (!r.ok) return say(r.body.error ?? "Verify failed");
      say(r.body.ok ? `Hash chain OK (${r.body.checked} snapshots)` : `Chain BROKEN: ${r.body.reason ?? "unknown reason"}`);
    } catch {
      say("Verify failed: API unreachable");
    }
  };

  const tabValue = (s: Snapshot): unknown =>
    ({ Input: s.input, "Resolved input": s.resolvedInput, Output: s.output, Error: s.error, "Context after": s.contextAfter, Raw: s })[tab];

  const m = data?.manifest;
  const planOnly = Boolean(data?.snapshots.some((s) => isPlan(s.output)));
  const executorLabel = planOnly ? "PLAN ONLY" : "GITHUB · LIVE";
  const outUrl = (snap?.output as { url?: unknown } | undefined)?.url;
  const canReplay = connected && !!data && m?.executor === "github";

  return (
    <div className="dbg">
      <div className="top">
        <Link href="/" className="mono" style={{ marginRight: 8 }}>← swy-tm</Link>
        <label className="sr" htmlFor="runsel">Run</label>
        <select
          id="runsel"
          value={runId ?? ""}
          onChange={(e) => {
            const selected = e.target.value;
            setRunId(selected);
            setStep(0);
          }}
          disabled={!runs.length}
        >
          {!runs.length && <option value="">No runs yet — run a workflow</option>}
          {runs.map((r) => (
            <option key={r.runId} value={r.runId}>
              {r.runId} · {r.workflowId} · {r.outcome}{r.parentRunId ? ` ← ${r.parentRunId}` : ""}
            </option>
          ))}
        </select>
        {m && <span className={`badge real`}>{executorLabel}</span>}
        <span style={{ flex: 1 }} />
        {connected && (
          <button className="btn sm ghost" onClick={() => setDockOpen((o) => !o)} aria-expanded={dockOpen}>
            {dockOpen ? "Hide launcher" : "Show launcher"}
          </button>
        )}
        <button className="btn sm ghost" disabled={busy || !canReplay} onClick={() => replay()}>
          Replay from step {from}
        </button>
        <button className="btn sm ghost" disabled={!data} onClick={verify}>
          Verify chain
        </button>
      </div>

      <div className={`banner ${connected ? "live" : ""}`} role="status">
        {loading
          ? "Loading…"
          : connected
            ? `LIVE · @${info?.login} · ${info?.repository} — every run below is a real GitHub run saved to your account only.`
            : "NOT CONNECTED — paste your own GitHub token and repository below. Nothing is shown until you connect, and every run you make is a real GitHub run."}
      </div>

      {(!connected || dockOpen) && (
        <section className="dock" aria-label={connected ? "Run a live workflow" : "Connect GitHub"}>
          {connected && info ? (
            <Launcher info={info} launch={launch} setLaunch={setLaunch} onRun={runWorkflow} onDisconnect={disconnect} busy={busy} />
          ) : (
            <ConnectForm onConnect={adopt} busy={connecting} error={connError} />
          )}
          {error && <p className="warn" role="alert" style={{ marginTop: 10 }}>{error}</p>}
        </section>
      )}

      <div className="panes">
        {/* ---- timeline ---- */}
        <section className="pane" aria-label="Timeline">
          <div className="label" style={{ marginBottom: 8 }}>
            Timeline {m ? `· ${m.workflowId}` : ""}{data ? ` · ${data.snapshots.length} snapshots` : ""}
          </div>
          {loading && <div className="label caret">Loading runs</div>}
          {!loading && !data && connected && <div className="label">No runs yet. Pick a workflow above and press “Run on GitHub”.</div>}
          <div role="listbox" aria-label="Steps" aria-activedescendant={snap ? `st-${si}` : undefined}>
            {data?.snapshots.map((s) => {
              const compensation = s.stepId.endsWith(":compensate");
              const mainIndex = main.indexOf(s);
              return (
                <button
                  key={s.seq}
                  id={compensation ? undefined : `st-${mainIndex}`}
                  role="option"
                  aria-selected={!compensation && mainIndex === si}
                  className="step"
                  style={compensation ? { opacity: 0.8 } : undefined}
                  onClick={() => {
                    if (!compensation) setStep(mainIndex);
                  }}
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
          {main.length > 0 && <TimelineScrubber steps={main.map((s) => ({ id: s.stepId, status: s.status }))} value={si} onChange={(v) => setStep(Math.round(v))} onCommit={setStep} />}
          <div className="label" style={{ marginTop: 16 }}>
            Side-effect ledger (your real GitHub changes)
          </div>
          {ledger && (
            <div className="kv" data-testid="ledger" style={{ marginTop: 6 }}>
              <span>created</span><b data-testid="ledger-created">{ledger.created}</b>
              <span>deleted</span><b data-testid="ledger-deleted">{ledger.deleted}</b>
              <span>labeled</span><b>{ledger.labeled}</b>
              {connected && <><span>commented</span><b>{ledger.commented ?? 0}</b></>}
              <span>updated</span><b>{ledger.updated}</b>
            </div>
          )}
        </section>

        {/* ---- inspector ---- */}
        <section className="pane" aria-label="Inspector">
          {snap ? (
            <>
              {snap.status === "error" && snap.error && (
                <div className="warn" role="alert" style={{ marginTop: 0, marginBottom: 12 }} data-testid="step-error">
                  <div className="mono red">Step “{snap.stepId}” failed{snap.error.category ? ` · ${snap.error.category}` : ""}</div>
                  <p style={{ margin: "8px 0" }}>{snap.error.message}</p>
                  {snap.error.suggestedAction && <p className="label">Next: {snap.error.suggestedAction}</p>}
                  {canReplay && <p className="label">Earlier steps already happened on GitHub. Fix the value in the replay panel, then replay from step {snap.stepIndex} — they will be reused, not repeated.</p>}
                </div>
              )}
              <div className="kv">
                <span className="label">step</span><span>{snap.stepIndex} · {snap.stepId}</span>
                <span className="label">canonicalId</span><span>{snap.canonicalId}</span>
                <span className="label">status</span><span style={{ color: snap.status === "error" ? "var(--alert)" : undefined }}>{snap.status}</span>
                <span className="label">sideEffect</span><span>{String(snap.sideEffect)}</span>
                <span className="label">executor</span><span>{snap.executor === "github" ? "GitHub REST API (live)" : snap.executor}</span>
                <span className="label">hash</span><span style={{ wordBreak: "break-all" }}>{snap.hash}</span>
                <span className="label">prevHash</span><span style={{ wordBreak: "break-all" }}>{snap.prevHash ?? "null"}</span>
              </div>
              {typeof outUrl === "string" && /^https:\/\/github\.com\//.test(outUrl) && (
                <p style={{ margin: "0 0 8px" }}>
                  <a className="mono" href={outUrl} target="_blank" rel="noreferrer noopener">Open this on GitHub ↗</a>
                </p>
              )}
              <div className="tabs" role="tablist" aria-label="Inspector tabs">
                {TABS.map((t) => (
                  <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>
                ))}
              </div>
              <div className="tabs">
                <input ref={search} type="text" placeholder="/ search" aria-label="Search JSON" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginLeft: "auto", width: 140 }} />
                <button
                  onClick={async () => {
                    await navigator.clipboard?.writeText(JSON.stringify(tabValue(snap), null, 2) ?? "").catch(() => {});
                    say("Copied");
                  }}
                >
                  copy
                </button>
              </div>
              <div className="json" data-testid="json">
                <JsonView value={tabValue(snap)} query={query} />
              </div>
            </>
          ) : (
            !loading && <div className="label">{connected ? "Run a workflow to inspect its steps." : "Connect GitHub above to start."}</div>
          )}
        </section>

        {/* ---- replay ---- */}
        <section className="pane" aria-label="Replay panel">
          <div className="label" style={{ marginBottom: 8 }}>Replay</div>
          {m && connected && (
            <div className="stats" data-testid="run-stats">
              <span><b>{m.executorCalls ?? m.steps.length}</b> GitHub calls</span>
              <span><b>{m.injectedSteps ?? 0}</b> steps reused</span>
              <span className={m.outcome === "ok" ? "okc" : "red"}><b>{m.outcome}</b></span>
            </div>
          )}
          {!connected && <div className="label" style={{ marginBottom: 10 }}>Connect GitHub to record and replay real runs.</div>}
          <label className="label" htmlFor="from">Replay from step</label>
          <select id="from" value={from} onChange={(e) => setFrom(Number(e.target.value))} style={{ width: "100%", margin: "4px 0 12px" }} disabled={!canReplay}>
            {m?.steps.map((s) => (
              <option key={s.id} value={s.index}>{s.index} · {s.id}</option>
            ))}
          </select>
          <div className="label">Overrides (path = value)</div>
          <datalist id="paths">{[...validPaths].map((p) => <option key={p} value={p} />)}</datalist>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 6, margin: "6px 0" }}>
              <input list="paths" aria-label={`Override path ${i + 1}`} aria-invalid={!rowOk(r)} placeholder="inputs.finalState" value={r.path} disabled={!canReplay} style={{ flex: 2, borderColor: rowOk(r) ? undefined : "var(--alert)" }} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, path: e.target.value } : y)))} />
              <input aria-label={`Override value ${i + 1}`} placeholder="closed" value={r.value} disabled={!canReplay} style={{ flex: 1 }} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))} />
              <button className="chipf" aria-label={`Remove override ${i + 1}`} onClick={() => setRows((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : [{ path: "", value: "" }]))}>×</button>
            </div>
          ))}
          {!formValid && <div className="label red" role="alert">Unknown override path — pick one from the list.</div>}
          <button className="chipf" onClick={() => setRows((x) => [...x, { path: "", value: "" }])} disabled={!canReplay}>+ add override</button>
          <div style={{ display: "grid", gap: 6, margin: "14px 0" }}>
            <label title="Undo the real GitHub effects of the steps being re-run (close the issue, remove the label, delete the comment) before running them again."><input type="checkbox" checked={compensate} onChange={(e) => setCompensate(e.target.checked)} disabled={!canReplay} /> Undo earlier effects first (compensate)</label>
            <label><input type="checkbox" checked={allowDup} onChange={(e) => setAllowDup(e.target.checked)} disabled={!canReplay} /> Allow duplicates (create new issue again)</label>
            <label><input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={!canReplay} /> Plan only (no GitHub changes)</label>
          </div>
          <button className="btn" disabled={busy || !formValid || !canReplay} onClick={() => replay()} style={{ width: "100%", justifyContent: "center" }}>
            {busy ? "Replaying…" : "Replay"}
          </button>

          {guard && (
            <div className="warn" role="alert" data-testid="guard">
              <div className="mono red">Side-effect guard · 409</div>
              <p style={{ margin: "8px 0" }}>Replaying from here would repeat real effects on GitHub: {guard.guarded.join(", ") || "(see message)"}. Nothing was sent.</p>
              <button
                className="btn sm red"
                onClick={() => {
                  setCompensate(true);
                  void replay(true);
                }}
              >
                Undo them, then replay
              </button>
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

      <div className="drawer two" aria-label="Divergence and live check">
        <div>
          {diff ? <DiffView diff={diff} onJump={(i) => setStep(i)} /> : <div className="label">Divergence — select a replayed run (one with a parent) or run a replay to see exactly what changed.</div>}
        </div>
        {connected ? (
          <LiveCheck report={report} busy={checking} disabled={!data || planOnly} onCheck={() => void checkLive(data)} />
        ) : (
          <div className="label">Live check — after you connect, this compares each run with what really exists on GitHub and flags drift.</div>
        )}
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
