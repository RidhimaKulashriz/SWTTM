"use client";
import type { Manifest, Snapshot } from "../core/types";
import { leaves, resolvedWithSources, show, type Plan, type Source } from "./plan";

function copy(text: string, done: (m: string) => void) {
  void (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(
    () => done("Copied"),
    () => done("Copy is not available in this browser"),
  );
}

function SourceTag({ source, snapshots }: { source: Source; snapshots: Snapshot[] }) {
  if (source.kind === "literal") return <span className="label">fixed in workflow</span>;
  if (source.kind === "mixed") return <span className="label">built from {source.refs.join(", ")}</span>;
  if (source.kind === "input") return <span className="label">from {source.ref}</span>;
  const from = snapshots.find((s) => s.stepId === source.stepId);
  return (
    <span className="label">
      from {source.ref}
      {from?.status === "injected" ? " (recorded value, not re-run)" : " (recorded)"}
    </span>
  );
}

/** Read one snapshot value by value: what went in, where each value came from, what came out, and what later steps can reference. */
export function SnapshotReader({
  snap,
  manifest,
  snapshots,
  onOverride,
  say,
}: {
  snap: Snapshot;
  manifest: Manifest;
  snapshots: Snapshot[];
  onOverride: (path: string, value: string, stepIndex: number) => void;
  say: (m: string) => void;
}) {
  const stepDef = manifest.workflow.steps[snap.stepIndex];
  const inputRows = resolvedWithSources(stepDef?.input, snap.resolvedInput);
  const outputRows = leaves(snap.output);
  const refs = leaves(snap.contextAfter?.steps ?? {}).map((l) => ({ ref: `steps.${l.path}`, value: l.value }));
  const inputs = leaves(snap.contextAfter?.inputs ?? {});
  const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

  return (
    <div data-testid="reader" className="reader">
      {snap.status === "injected" && (
        <p className="note">
          <b>Reused, not executed.</b> This value was copied from {manifest.parentRunId ? `run ${manifest.parentRunId}` : "the earlier recording"}, step {snap.stepIndex}. GitHub was not called for it.
        </p>
      )}

      <div className="label">Values this step received</div>
      <table className="vtable" aria-label="Resolved input values">
        <tbody>
          {inputRows.length === 0 && (
            <tr><td className="label" colSpan={3}>No input.</td></tr>
          )}
          {inputRows.map((r) => (
            <tr key={r.path}>
              <td className="mono">{r.path}</td>
              <td className="mono val">{show(r.value, 80)}</td>
              <td>
                <SourceTag source={r.source} snapshots={snapshots} />
                {r.source.kind === "input" && (
                  <button className="chipf" onClick={() => onOverride((r.source as { ref: string }).ref, asText(r.value), snap.stepIndex)} title="Add this value to the replay overrides so you can change it">
                    change on replay
                  </button>
                )}
                {r.source.kind === "literal" && (
                  <button className="chipf" onClick={() => onOverride(`steps.${snap.stepId}.input.${r.path}`, asText(r.value), snap.stepIndex)} title="Override this fixed value for the replay">
                    change on replay
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="label" style={{ marginTop: 14 }}>
        {snap.status === "error" ? "Error returned instead of a value" : "Value this step produced (a replay injects exactly this)"}
      </div>
      <table className="vtable" aria-label="Output values">
        <tbody>
          {snap.status === "error" && snap.error && (
            <tr>
              <td className="mono red">error</td>
              <td className="mono val" colSpan={2}>{snap.error.message}</td>
            </tr>
          )}
          {snap.status !== "error" && outputRows.length === 0 && <tr><td className="label" colSpan={3}>No output.</td></tr>}
          {outputRows.map((r) => (
            <tr key={r.path}>
              <td className="mono">output.{r.path}</td>
              <td className="mono val">{show(r.value, 80)}</td>
              <td>
                <button className="chipf" onClick={() => copy(asText(r.value), say)}>copy</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="label" style={{ marginTop: 14 }}>Everything later steps can reference after this step</div>
      <table className="vtable" aria-label="Context values">
        <tbody>
          {inputs.map((r) => (
            <tr key={`i-${r.path}`}>
              <td className="mono">{`{{inputs.${r.path}}}`}</td>
              <td className="mono val">{show(r.value, 80)}</td>
              <td>
                <button className="chipf" onClick={() => copy(`{{inputs.${r.path}}}`, say)}>copy ref</button>
              </td>
            </tr>
          ))}
          {refs.map((r) => (
            <tr key={r.ref}>
              <td className="mono">{`{{${r.ref}}}`}</td>
              <td className="mono val">{show(r.value, 80)}</td>
              <td>
                <button className="chipf" onClick={() => copy(`{{${r.ref}}}`, say)}>copy ref</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ACTION: Record<string, { mark: string; text: string }> = {
  reuse: { mark: "⟲", text: "reuse recorded value" },
  run: { mark: "▶", text: "call GitHub" },
  undo: { mark: "↩", text: "undo, then call GitHub" },
  preview: { mark: "◌", text: "plan only, no call" },
};

/** What a replay will do, step by step, before you press the button. */
export function ReplayPlanView({ plan }: { plan: Plan }) {
  return (
    <div className="plan" data-testid="plan" aria-label="Replay plan">
      <div className="label">Replay plan · {plan.blocked || plan.unusable ? "blocked" : `${plan.calls} GitHub call(s), ${plan.reused} step(s) reused`}</div>
      {plan.unusable && <p className="warn" role="alert">{plan.unusable}</p>}
      {plan.blocked && !plan.unusable && (
        <p className="warn" role="alert" data-testid="plan-blocked">
          The side-effect guard will stop this: {plan.guarded.join(", ")} already happened on GitHub. Tick “Undo earlier effects first”, allow duplicates, or replay from a later step.
        </p>
      )}
      <ol>
        {plan.rows.map((r) => (
          <li key={r.index} className={`plan-${r.action}`}>
            <span className="mono">{ACTION[r.action].mark} {r.index} · {r.stepId}</span>
            <span className="label">{ACTION[r.action].text}{r.repeats && !plan.blocked && r.action === "run" ? " · repeats an effect" : ""}</span>
            {r.recorded && <span className="mono rec">{r.action === "reuse" ? "injects " : "recorded "}{r.recorded}</span>}
          </li>
        ))}
      </ol>
      {plan.changes.length > 0 && (
        <>
          <div className="label" style={{ marginTop: 8 }}>Values that change</div>
          <ul className="changes">
            {plan.changes.map((c) => (
              <li key={c.path} className="mono">
                {c.path}: <s>{c.known ? show(c.before, 30) : "(new)"}</s> → <b>{show(c.after, 30)}</b>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
