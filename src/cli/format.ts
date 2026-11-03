import { Chalk } from "chalk";
import type { DiffResult } from "../core/diff";
import type { Manifest, Snapshot } from "../core/types";
import { fmtValue, diffToMarkdown } from "../core/report";

export { fmtValue, diffToMarkdown };

let color = !!process.stdout.isTTY && !process.env.NO_COLOR;
export function setColor(on: boolean) {
  color = on;
}
const c = () => new Chalk({ level: color ? 1 : 0 });

export const paint = {
  red: (s: string) => c().red(s),
  green: (s: string) => c().green(s),
  yellow: (s: string) => c().yellow(s),
  dim: (s: string) => c().dim(s),
  bold: (s: string) => c().bold(s),
  cyan: (s: string) => c().cyan(s),
};

export const label = (mock: boolean) => (mock ? "MOCK" : "SWYTCHCODE");

export function statusColor(s: string): string {
  if (s === "ok") return paint.green(s);
  if (s === "error") return paint.red(s);
  return paint.dim(s);
}

export function stepTable(snaps: Snapshot[]): string {
  return snaps
    .map((s) => {
      const name = `${String(s.stepIndex).padStart(2, " ")} ${s.stepId}`.padEnd(26);
      const extra = s.status === "error" ? paint.red(`  ${fmtValue(s.error)}`) : "";
      return `  ${name} ${statusColor(s.status.padEnd(9))} ${paint.dim(`${s.durationMs}ms  ${s.hash.slice(0, 8)}`)}${s.sideEffect ? paint.yellow("  ⚡side-effect") : ""}${extra}`;
    })
    .join("\n");
}

export function runLine(m: Manifest): string {
  const out = m.outcome === "ok" ? paint.green("ok") : paint.red("failed");
  return `${m.runId.padEnd(12)} ${m.workflowId.padEnd(18)} ${out.padEnd(m.outcome === "ok" ? 6 : 8)} ${(m.parentRunId ?? "-").padEnd(12)} ${m.createdAt}${m.mock ? paint.yellow("  MOCK") : ""}`;
}

export function renderDiff(d: DiffResult, meta: { replay: Manifest; mock: boolean; calls?: number; injected?: number }): string {
  const lines: string[] = [];
  const from = meta.replay.parentRunId ? `from ${meta.replay.parentRunId}, step ${meta.replay.replayFromStep} "${meta.replay.steps[meta.replay.replayFromStep ?? 0]?.id}"` : `vs ${d.a}`;
  lines.push(paint.bold(`Replay ${d.b} (${from}) — ${label(meta.mock)} executor`));
  for (const s of d.steps) {
    const head = `step ${s.index} ${s.stepId.padEnd(8)}`;
    const mode = s.injectedB ? "injected" : s.statusB === "ok" || s.statusB === "error" ? "executed" : (s.statusB ?? "—");
    if (s.state === "identical") {
      lines.push(`${head} ${paint.dim(mode.padEnd(10))} ·  identical`);
      continue;
    }
    if (s.state === "only-a" || s.state === "only-b") {
      lines.push(`${head} ${paint.yellow(s.state.toUpperCase().padEnd(10))} ·  step exists in one run only`);
      continue;
    }
    const statusChange = s.statusA !== s.statusB ? `status: ${s.statusA} → ${s.statusB}` : "";
    lines.push(`${head} ${paint.red("DIVERGED".padEnd(10))} ·  ${statusChange}`.trimEnd());
    const w = Math.max(...s.changes.filter((x) => !x.volatile && x.path !== "status").map((x) => x.path.length), 0);
    for (const ch of s.changes) {
      if (ch.volatile || ch.path === "status") continue;
      lines.push(`   ${ch.path.padEnd(w)} : ${paint.red(fmtValue(ch.before))} → ${paint.green(fmtValue(ch.after))}`);
    }
  }
  const vol = d.volatile.map((v) => v.path);
  lines.push(paint.dim(`volatile fields ignored: ${vol.length}${vol.length ? ` (${[...new Set(vol)].join(", ")})` : ""}`));
  const calls = meta.calls ?? meta.replay.executorCalls ?? 0;
  const inj = meta.injected ?? meta.replay.injectedSteps ?? 0;
  lines.push(paint.bold(`executor calls: ${calls} (injected: ${inj})`));
  return lines.join("\n");
}
