import type { Snapshot } from "./types";
import { canonicalJson } from "./json";

export type Change = {
  path: string;
  before: unknown;
  after: unknown;
  kind: "changed" | "added" | "removed";
  volatile: boolean;
};

export type StepDiff = {
  index: number;
  stepId: string;
  state: "identical" | "diverged" | "only-a" | "only-b";
  statusA?: string;
  statusB?: string;
  injectedB: boolean;
  changes: Change[];
};

export type DiffResult = {
  a: string;
  b: string;
  steps: StepDiff[];
  volatile: Change[];
  firstDivergence: number | null;
};

const VOLATILE_KEY = /(^|_)(created|updated|timestamp|time|at)$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function globToRegex(g: string): RegExp {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^.]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${esc}$`);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function deepDiff(before: unknown, after: unknown, path: string, out: Omit<Change, "volatile">[]) {
  if (before === undefined && after === undefined) return;
  if (before === undefined) {
    if (isObj(after)) return Object.keys(after).forEach((k) => deepDiff(undefined, after[k], `${path}.${k}`, out));
    if (Array.isArray(after) && after.length) return after.forEach((v, i) => deepDiff(undefined, v, `${path}.${i}`, out));
    return void out.push({ path, before: undefined, after, kind: "added" });
  }
  if (after === undefined) {
    if (isObj(before)) return Object.keys(before).forEach((k) => deepDiff(before[k], undefined, `${path}.${k}`, out));
    if (Array.isArray(before) && before.length) return before.forEach((v, i) => deepDiff(v, undefined, `${path}.${i}`, out));
    return void out.push({ path, before, after: undefined, kind: "removed" });
  }
  if (isObj(before) && isObj(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) deepDiff(before[k], after[k], `${path}.${k}`, out);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let i = 0; i < Math.max(before.length, after.length); i++) deepDiff(before[i], after[i], `${path}.${i}`, out);
    return;
  }
  if (canonicalJson(before) !== canonicalJson(after)) out.push({ path, before, after, kind: "changed" });
}

export function diffRuns(
  a: { runId: string; steps: Snapshot[] },
  b: { runId: string; steps: Snapshot[] },
  opts: { ignore?: string[] } = {},
): DiffResult {
  const ignores = (opts.ignore ?? []).map(globToRegex);
  const isVolatile = (c: Omit<Change, "volatile">): boolean => {
    const last = c.path.split(".").pop() ?? "";
    if (VOLATILE_KEY.test(last) || /x-request-id/i.test(c.path)) return true;
    if (ignores.some((r) => r.test(c.path))) return true;
    return typeof c.before === "string" && typeof c.after === "string" && ISO.test(c.before) && ISO.test(c.after);
  };
  const norm = (s?: Snapshot) => (s ? (s.status === "injected" ? "ok" : s.status) : undefined);
  const n = Math.max(...a.steps.map((s) => s.stepIndex + 1), ...b.steps.map((s) => s.stepIndex + 1), 0);
  const steps: StepDiff[] = [];
  const volatile: Change[] = [];
  for (let i = 0; i < n; i++) {
    const A = a.steps.find((s) => s.stepIndex === i);
    const B = b.steps.find((s) => s.stepIndex === i);
    const base = { index: i, stepId: (B ?? A)!.stepId, statusA: A?.status, statusB: B?.status, injectedB: B?.status === "injected" };
    if (!A || !B) {
      steps.push({ ...base, state: A ? "only-a" : "only-b", changes: [] });
      continue;
    }
    const raw: Omit<Change, "volatile">[] = [];
    if (norm(A) !== norm(B)) raw.push({ path: "status", before: norm(A), after: norm(B), kind: "changed" });
    deepDiff(A.resolvedInput, B.resolvedInput, "resolvedInput", raw);
    deepDiff(A.output, B.output, "output", raw);
    if (canonicalJson(A.error) !== canonicalJson(B.error)) {
      raw.push({ path: "error", before: A.error, after: B.error, kind: A.error ? (B.error ? "changed" : "removed") : "added" });
    }
    const changes = raw.map((c) => ({ ...c, volatile: isVolatile(c) }));
    volatile.push(...changes.filter((c) => c.volatile).map((c) => ({ ...c, path: `${c.path}` })));
    const real = changes.filter((c) => !c.volatile);
    steps.push({ ...base, state: real.length ? "diverged" : "identical", changes });
  }
  const first = steps.find((s) => s.state !== "identical");
  return { a: a.runId, b: b.runId, steps, volatile, firstDivergence: first ? first.index : null };
}
