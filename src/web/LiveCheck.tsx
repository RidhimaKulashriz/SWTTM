"use client";
import type { ReconcileReport } from "../server/reconcile";

const TONE: Record<string, string> = { in_sync: "ok", drift: "warn", missing: "bad", error: "bad" };
const TEXT: Record<string, string> = { in_sync: "IN SYNC", drift: "DRIFT", missing: "MISSING", error: "CHECK FAILED" };

export function LiveCheck({ report, busy, onCheck, disabled }: { report: ReconcileReport | null; busy: boolean; onCheck: () => void; disabled: boolean }) {
  return (
    <section className="livecheck" aria-label="Live check against GitHub">
      <div className="lc-head">
        <div>
          <div className="label">LIVE CHECK · SNAPSHOTS vs. GITHUB RIGHT NOW</div>
          {report ? (
            <div className="label" data-testid="livecheck-summary">
              {report.repository} · {report.summary.inSync} in sync · {report.summary.drift} drifted · {report.summary.missing + report.summary.error} unavailable · checked {new Date(report.checkedAt).toLocaleTimeString()}
            </div>
          ) : (
            <div className="label">Asks GitHub what really exists and compares it with what this run recorded.</div>
          )}
        </div>
        <button className="btn sm ghost" disabled={busy || disabled} onClick={onCheck}>{busy ? "Checking…" : "Check against GitHub"}</button>
      </div>
      {report && report.issues.length === 0 && <div className="label">This run has no recorded GitHub changes to check (plan-only runs change nothing).</div>}
      <div className="lc-list">
        {report?.issues.map((i) => (
          <div key={i.number} className={`lc-card ${TONE[i.status]}`}>
            <div className="srow">
              <a className="mono" href={i.url} target="_blank" rel="noreferrer noopener">#{i.number} {i.title ?? ""} ↗</a>
              <span className={`chip ${TONE[i.status]}`}>{TEXT[i.status]}</span>
            </div>
            <div className="label">
              recorded: {i.recorded.state ?? "?"} · [{i.recorded.labels.join(", ")}] · {i.recorded.comments} comment(s)
            </div>
            {i.live && (
              <div className="label">
                on GitHub: {i.live.state} · [{i.live.labels.join(", ")}] · {i.live.comments} comment(s)
              </div>
            )}
            {i.notes.map((n, k) => <div key={k} className="label red">{n}</div>)}
          </div>
        ))}
      </div>
      {report?.truncated && <div className="label">Showing the first {report.issues.length} issues.</div>}
    </section>
  );
}
