/**
 * Pure helpers behind the debugger's "replay values" and "snapshot reader" views.
 * They mirror the rules of the real engine (core/engine.ts) so what the UI predicts is what a replay does.
 */
import type { Manifest, Snapshot } from "../core/types";

export type Leaf = { path: string; value: unknown };

/** Every primitive (or empty container) in a JSON value, as dot-paths. */
export function leaves(v: unknown, prefix = ""): Leaf[] {
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return prefix ? [{ path: prefix, value: Array.isArray(v) ? [] : {} }] : [];
    return entries.flatMap(([k, val]) => leaves(val, prefix ? `${prefix}.${k}` : k));
  }
  return prefix ? [{ path: prefix, value: v }] : [];
}

export function getAt(obj: unknown, path: string): { found: boolean; value?: unknown } {
  let cur: unknown = obj;
  for (const p of path.split(".")) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[p];
    else return { found: false };
  }
  return { found: true, value: cur };
}

export function show(v: unknown, max = 60): string {
  const s = v === undefined ? "(absent)" : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* ------------------------------------------------------------------ */
/* where did a resolved value come from?                               */
/* ------------------------------------------------------------------ */

export type Source =
  | { kind: "literal" }
  | { kind: "input"; ref: string }
  | { kind: "step"; ref: string; stepId: string }
  | { kind: "mixed"; refs: string[] };

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;

function sourceOf(template: unknown): Source {
  if (typeof template !== "string") return { kind: "literal" };
  const refs = [...template.matchAll(TEMPLATE)].map((m) => m[1]);
  if (refs.length === 0) return { kind: "literal" };
  const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.test(template);
  if (refs.length === 1 && whole) {
    const ref = refs[0];
    if (ref.startsWith("steps.")) return { kind: "step", ref, stepId: ref.split(".")[1] };
    return { kind: "input", ref };
  }
  return { kind: "mixed", refs };
}

export type ValueRow = Leaf & { source: Source };

/** Resolved input of a step, each value tagged with the template it came from (input, earlier step, literal). */
export function resolvedWithSources(template: unknown, resolved: unknown): ValueRow[] {
  return leaves(resolved).map((leaf) => {
    const t = getAt(template, leaf.path);
    return { ...leaf, source: t.found ? sourceOf(t.value) : { kind: "literal" } };
  });
}

/* ------------------------------------------------------------------ */
/* replay plan                                                         */
/* ------------------------------------------------------------------ */

export type PlanAction = "reuse" | "run" | "preview" | "undo";

export type PlanRow = {
  index: number;
  stepId: string;
  canonicalId: string;
  sideEffect: boolean;
  action: PlanAction;
  /** a short summary of the value that is injected (reuse) or was recorded before (run) */
  recorded: string;
  /** side-effecting step that already happened on GitHub and would happen again */
  repeats: boolean;
};

export type ValueChange = { path: string; before: unknown; after: unknown; known: boolean };

export type Plan = {
  from: number;
  rows: PlanRow[];
  changes: ValueChange[];
  calls: number;
  reused: number;
  undone: number;
  /** the engine refuses (exit 3) unless you undo, allow duplicates, or plan only */
  blocked: boolean;
  guarded: string[];
  /** a step before `from` is unusable, so the engine refuses (exit 4) */
  unusable: string | null;
};

export function parseOverrideValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function summarize(output: unknown): string {
  if (output === undefined) return "";
  if (!output || typeof output !== "object") return show(output);
  return leaves(output)
    .filter((l) => !/(^|\.)(url|updated_at|id)$/.test(l.path) && l.value !== null)
    .slice(0, 3)
    .map((l) => `${l.path}=${show(l.value, 28)}`)
    .join(" · ");
}

export function planReplay(
  manifest: Manifest,
  snapshots: Snapshot[],
  opts: { from: number; overrides: string[]; compensate: boolean; allowDuplicate: boolean; dryRun: boolean },
): Plan {
  const main = snapshots.filter((s) => !s.stepId.endsWith(":compensate"));
  const byIndex = (i: number) => main.find((s) => s.stepIndex === i);
  const from = Math.max(0, Math.min(opts.from, manifest.steps.length - 1));

  let unusable: string | null = null;
  for (let i = 0; i < from; i++) {
    const s = byIndex(i);
    if (!s || (s.status !== "ok" && s.status !== "injected")) {
      unusable = `Step ${i} "${manifest.steps[i].id}" has ${s ? `status "${s.status}"` : "no snapshot"}, so it cannot be reused. Replay from step ${i} instead.`;
      break;
    }
  }

  const guardedSnaps = main.filter((s) => s.stepIndex >= from && s.sideEffect && (s.status === "ok" || s.status === "injected"));
  const guarded = guardedSnaps.map((s) => `${s.stepIndex}:${s.stepId}`);
  const blocked = guardedSnaps.length > 0 && !opts.dryRun && !opts.allowDuplicate && !opts.compensate;
  const undoing = opts.compensate && !opts.dryRun;

  const rows: PlanRow[] = manifest.steps.map((st) => {
    const snap = byIndex(st.index);
    const reuse = st.index < from;
    const happened = Boolean(snap && (snap.status === "ok" || snap.status === "injected") && snap.sideEffect);
    return {
      index: st.index,
      stepId: st.id,
      canonicalId: st.canonicalId,
      sideEffect: st.sideEffect,
      action: reuse ? "reuse" : opts.dryRun ? "preview" : undoing && happened ? "undo" : "run",
      recorded: snap ? (snap.status === "error" ? `failed: ${snap.error?.message.slice(0, 70) ?? "error"}` : summarize(snap.output)) : "—",
      repeats: !reuse && happened && !opts.dryRun,
    };
  });

  const changes: ValueChange[] = opts.overrides.flatMap((o) => {
    const eq = o.indexOf("=");
    if (eq < 1) return [];
    const path = o.slice(0, eq).trim();
    const after = parseOverrideValue(o.slice(eq + 1));
    let before = path.startsWith("inputs.") ? getAt({ inputs: manifest.inputs }, path) : { found: false, value: undefined as unknown };
    if (!before.found) {
      const m = /^steps\.([^.]+)\.input\.(.+)$/.exec(path);
      const step = m && manifest.workflow.steps.find((s) => s.id === m[1]);
      if (step && m) before = getAt(step.input, m[2]);
    }
    return [{ path, before: before.value, after, known: before.found }];
  });

  const undone = rows.filter((r) => r.action === "undo").length;
  const reused = rows.filter((r) => r.action === "reuse").length;
  const calls = rows.filter((r) => r.action === "run").length + undone * 2;
  return { from, rows, changes, calls: blocked || unusable ? 0 : calls, reused, undone, blocked, guarded, unusable };
}
