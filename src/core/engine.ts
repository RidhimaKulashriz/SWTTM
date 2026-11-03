import {
  InterpolationError,
  TmError,
  WorkflowSchema,
  type Context,
  type ExecResult,
  type Executor,
  type Manifest,
  type Snapshot,
  type StepError,
  type Workflow,
} from "./types";
import { Store, newRunId } from "./store";
import { clone, getPath, hashSnapshot, interpolate, parseValue, redact, setPath } from "./util";

export type Hooks = { onStep?: (s: Snapshot) => void };

/* ------------------------------------------------------------------ */
/* overrides                                                            */
/* ------------------------------------------------------------------ */

export function applyOverrides(
  wf: Workflow,
  baseInputs: Record<string, unknown>,
  overrides: string[],
  fromStep = 0,
): { workflow: Workflow; inputs: Record<string, unknown> } {
  const workflow = clone(wf);
  const inputs = clone(baseInputs);
  for (const ov of overrides) {
    const eq = ov.indexOf("=");
    if (eq < 1) throw new TmError(`Bad override "${ov}". Use path=value, e.g. --set inputs.finalState=closed`, 2);
    const parts = ov.slice(0, eq).split(".");
    const value = parseValue(ov.slice(eq + 1));
    if (parts[0] === "inputs" && parts.length > 1) {
      if (!getPath(inputs, parts.slice(1)).found) {
        throw new TmError(
          `Unknown override path "${parts.join(".")}". Known inputs: ${Object.keys(inputs).join(", ") || "(none)"}`,
          2,
        );
      }
      setPath(inputs, parts.slice(1), value);
    } else if (parts[0] === "steps" && parts[2] === "input" && parts.length > 3) {
      const idx = workflow.steps.findIndex((s) => s.id === parts[1]);
      if (idx < 0) throw new TmError(`Unknown step "${parts[1]}" in override "${parts.join(".")}". Steps: ${workflow.steps.map((s) => s.id).join(", ")}`, 2);
      if (idx < fromStep) {
        throw new TmError(`Step "${parts[1]}" is injected (not re-executed) when replaying from step ${fromStep}; override a step at or after it.`, 2);
      }
      const step = workflow.steps[idx];
      if (!getPath(step.input, parts.slice(3)).found) {
        throw new TmError(`Unknown override path "${parts.join(".")}": step "${step.id}" has no input key "${parts.slice(3).join(".")}"`, 2);
      }
      setPath(step.input, parts.slice(3), value);
    } else {
      throw new TmError(`Unsupported override path "${parts.join(".")}". Use inputs.<key> or steps.<id>.input.<path>`, 2);
    }
  }
  return { workflow, inputs };
}

/* ------------------------------------------------------------------ */
/* recorder (hash chain)                                                */
/* ------------------------------------------------------------------ */

class Recorder {
  seq = 0;
  prev: string | null = null;
  constructor(
    private store: Store,
    private base: { runId: string; workflowId: string; executor: Executor },
    private hooks: Hooks,
  ) {}

  write(p: {
    stepIndex: number;
    stepId: string;
    canonicalId: string;
    startedAt: string;
    durationMs: number;
    input: unknown;
    resolvedInput: unknown;
    status: Snapshot["status"];
    output?: unknown;
    error?: StepError;
    sideEffect: boolean;
    contextAfter: Context;
    executor?: Executor;
  }): Snapshot {
    const ex = p.executor ?? this.base.executor;
    const draft = redact({
      schema: 1,
      runId: this.base.runId,
      workflowId: this.base.workflowId,
      seq: this.seq++,
      stepIndex: p.stepIndex,
      stepId: p.stepId,
      canonicalId: p.canonicalId,
      startedAt: p.startedAt,
      durationMs: p.durationMs,
      input: p.input,
      resolvedInput: p.resolvedInput,
      status: p.status,
      output: p.output,
      error: p.error,
      sideEffect: p.sideEffect,
      executor: ex.name,
      mock: ex.mock,
      contextAfter: p.contextAfter,
      prevHash: this.prev,
    });
    const snap = { ...draft, hash: hashSnapshot(draft as unknown as Record<string, unknown>) } as unknown as Snapshot;
    this.prev = snap.hash;
    this.store.writeSnapshot(snap);
    this.hooks.onStep?.(snap);
    return snap;
  }
}

/* ------------------------------------------------------------------ */
/* shared step execution                                                */
/* ------------------------------------------------------------------ */

type Tally = { calls: number };

async function execDefinition(
  rec: Recorder,
  executor: Executor,
  ctx: Context,
  def: { id: string; canonical_id: string; input?: unknown },
  meta: { stepIndex: number; stepId: string; sideEffect: boolean },
  dryRun: boolean,
  tally: Tally,
  record: boolean,
): Promise<Snapshot> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let resolved: unknown;
  let result: ExecResult;
  try {
    resolved = interpolate(def.input ?? {}, ctx, def.id);
    tally.calls++;
    result = await executor.exec(def.canonical_id, resolved, { dryRun });
  } catch (e) {
    if (e instanceof InterpolationError) {
      result = { ok: false, error: { category: "interpolation", message: e.message, retryable: false } };
    } else {
      result = { ok: false, error: { category: "executor", message: (e as Error).message } };
    }
  }
  if (result.ok && record) ctx.steps[def.id] = { input: resolved, output: result.output };
  return rec.write({
    stepIndex: meta.stepIndex,
    stepId: meta.stepId,
    canonicalId: def.canonical_id,
    startedAt,
    durationMs: Date.now() - t0,
    input: def.input ?? {},
    resolvedInput: resolved,
    status: result.ok ? "ok" : "error",
    output: result.ok ? result.output : undefined,
    error: result.ok ? undefined : result.error,
    sideEffect: meta.sideEffect,
    contextAfter: clone(ctx),
  });
}

async function runTail(
  workflow: Workflow,
  from: number,
  ctx: Context,
  rec: Recorder,
  executor: Executor,
  dryRun: boolean,
  tally: Tally,
): Promise<{ outcome: "ok" | "failed"; failedStep?: number }> {
  for (let i = from; i < workflow.steps.length; i++) {
    const s = workflow.steps[i];
    const snap = await execDefinition(rec, executor, ctx, s, { stepIndex: i, stepId: s.id, sideEffect: s.sideEffect }, dryRun, tally, true);
    if (snap.status === "error") return { outcome: "failed", failedStep: i };
  }
  return { outcome: "ok" };
}

function manifestFor(
  runId: string,
  workflow: Workflow,
  inputs: Record<string, unknown>,
  executor: Executor,
  extra: Partial<Manifest>,
): Manifest {
  return {
    runId,
    workflowId: workflow.id,
    createdAt: new Date().toISOString(),
    executor: executor.name,
    mock: executor.mock,
    steps: workflow.steps.map((s, index) => ({ index, id: s.id, canonicalId: s.canonical_id, sideEffect: s.sideEffect })),
    outcome: "ok",
    workflow,
    inputs,
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* run                                                                  */
/* ------------------------------------------------------------------ */

export type RunResult = { manifest: Manifest; snapshots: Snapshot[]; executorCalls: number; injected: number };

export async function runWorkflow(
  rawWorkflow: unknown,
  opts: { store: Store; executor: Executor; overrides?: string[]; runId?: string; dryRun?: boolean; hooks?: Hooks },
): Promise<RunResult> {
  const parsed = WorkflowSchema.safeParse(rawWorkflow);
  if (!parsed.success) {
    throw new TmError(`Invalid workflow: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, 2);
  }
  const { workflow, inputs } = applyOverrides(parsed.data, parsed.data.inputs, opts.overrides ?? []);
  const runId = opts.runId ?? newRunId();
  if (opts.store.exists(runId)) throw new TmError(`Run id "${runId}" already exists. Pick another with --run-id.`, 2);
  const rec = new Recorder(opts.store, { runId, workflowId: workflow.id, executor: opts.executor }, opts.hooks ?? {});
  const ctx: Context = { inputs, steps: {} };
  const tally = { calls: 0 };
  const r = await runTail(workflow, 0, ctx, rec, opts.executor, !!opts.dryRun, tally);
  const manifest = manifestFor(runId, workflow, inputs, opts.executor, {
    outcome: r.outcome,
    failedStep: r.failedStep,
    overrides: opts.overrides?.length ? opts.overrides : undefined,
    executorCalls: tally.calls,
    injectedSteps: 0,
  });
  opts.store.writeManifest(manifest);
  return { manifest, snapshots: opts.store.readSnapshots(runId), executorCalls: tally.calls, injected: 0 };
}

/* ------------------------------------------------------------------ */
/* replay                                                               */
/* ------------------------------------------------------------------ */

export type ReplayOptions = {
  store: Store;
  executor: Executor;
  runId: string;
  fromStep: string | number;
  overrides?: string[];
  compensate?: boolean;
  allowDuplicate?: boolean;
  dryRun?: boolean;
  newRunId?: string;
  hooks?: Hooks;
};

export type ReplayResult = RunResult & { compensated: string[]; guarded: string[] };

export function resolveStepIndex(m: Manifest, ref: string | number): number {
  const asNum = typeof ref === "number" ? ref : /^\d+$/.test(ref) ? Number(ref) : NaN;
  const idx = Number.isNaN(asNum) ? m.steps.findIndex((s) => s.id === ref) : asNum;
  if (idx < 0 || idx >= m.steps.length) {
    throw new TmError(`Unknown step "${ref}" in run ${m.runId}. Steps: ${m.steps.map((s) => `${s.index}:${s.id}`).join(", ")}`, 2);
  }
  return idx;
}

export async function replayRun(o: ReplayOptions): Promise<ReplayResult> {
  const { store, executor } = o;
  const orig = store.readManifest(o.runId);
  const origSnaps = store.readSteps(o.runId);
  const k = resolveStepIndex(orig, o.fromStep);

  // 1. snapshots 0..k-1 must be usable
  for (let i = 0; i < k; i++) {
    const s = origSnaps.find((x) => x.stepIndex === i);
    if (!s || (s.status !== "ok" && s.status !== "injected")) {
      throw new TmError(
        `Cannot replay from step ${k}: step ${i} "${orig.steps[i].id}" has ${s ? `status "${s.status}"` : "no snapshot"}. Replay from step ${i} instead: swy-tm replay ${o.runId} --from-step ${i}`,
        4,
      );
    }
  }

  // 4. overrides (validated before anything is executed)
  const { workflow, inputs } = applyOverrides(orig.workflow, orig.inputs, o.overrides ?? [], k);

  // 5. side-effect guard (before anything is executed)
  const guardedSnaps = origSnaps.filter((s) => s.stepIndex >= k && s.sideEffect && (s.status === "ok" || s.status === "injected"));
  const guarded = guardedSnaps.map((s) => `${s.stepIndex}:${s.stepId}`);
  const useCompensation = !!o.compensate && !o.dryRun && guardedSnaps.length > 0;
  if (guardedSnaps.length && !o.dryRun && !o.allowDuplicate && !o.compensate) {
    throw new TmError(
      `Side-effect guard: replaying from step ${k} would repeat real effects of ${guarded.join(", ")}. Nothing was executed.\nNext: add --compensate (runs the defined compensation first) or --allow-duplicate, or replay from a later step.`,
      3,
      { guarded },
    );
  }
  if (useCompensation) {
    const missing = guardedSnaps.filter((s) => !orig.workflow.steps[s.stepIndex].compensate);
    if (missing.length) {
      throw new TmError(
        `Cannot compensate: step(s) ${missing.map((s) => `${s.stepIndex}:${s.stepId}`).join(", ")} define no "compensate". Nothing was executed.\nNext: add a compensate block to the workflow, or use --allow-duplicate.`,
        3,
        { guarded, missingCompensate: missing.map((s) => s.stepId) },
      );
    }
  }

  const runId = o.newRunId ?? newRunId();
  const rec = new Recorder(store, { runId, workflowId: orig.workflowId, executor }, o.hooks ?? {});
  const tally = { calls: 0 };
  const compensated: string[] = [];

  // 3. injected snapshots (executor is NOT called)
  for (let i = 0; i < k; i++) {
    const s = origSnaps.find((x) => x.stepIndex === i)!;
    rec.write({
      stepIndex: i,
      stepId: s.stepId,
      canonicalId: s.canonicalId,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      input: s.input,
      resolvedInput: s.resolvedInput,
      status: "injected",
      output: s.output,
      sideEffect: s.sideEffect,
      contextAfter: { ...clone(s.contextAfter), inputs: clone(inputs) },
      executor: { name: s.executor, mock: s.mock } as Executor,
    });
  }

  // compensation (reverse order)
  let compFailed: number | undefined;
  if (useCompensation) {
    for (const s of [...guardedSnaps].reverse()) {
      const comp = orig.workflow.steps[s.stepIndex].compensate!;
      const ctx = clone(s.contextAfter);
      const snap = await execDefinition(
        rec,
        executor,
        ctx,
        { id: `${s.stepId}:compensate`, canonical_id: comp.canonical_id, input: comp.input },
        { stepIndex: s.stepIndex, stepId: `${s.stepId}:compensate`, sideEffect: true },
        false,
        tally,
        false,
      );
      compensated.push(s.stepId);
      if (snap.status === "error") {
        compFailed = s.stepIndex;
        break;
      }
    }
  }

  // 2 + 6. context + execute tail
  const ctx: Context =
    k === 0 ? { inputs: clone(inputs), steps: {} } : { ...clone(origSnaps.find((x) => x.stepIndex === k - 1)!.contextAfter), inputs: clone(inputs) };
  let outcome: { outcome: "ok" | "failed"; failedStep?: number } = { outcome: "failed", failedStep: compFailed };
  if (compFailed === undefined) outcome = await runTail(workflow, k, ctx, rec, executor, !!o.dryRun, tally);

  const manifest = manifestFor(runId, workflow, inputs, executor, {
    parentRunId: o.runId,
    replayFromStep: k,
    overrides: o.overrides?.length ? o.overrides : undefined,
    outcome: outcome.outcome,
    failedStep: outcome.failedStep,
    executorCalls: tally.calls,
    injectedSteps: k,
  });
  store.writeManifest(manifest);
  return { manifest, snapshots: store.readSnapshots(runId), executorCalls: tally.calls, injected: k, compensated, guarded };
}

/* ------------------------------------------------------------------ */
/* verify                                                               */
/* ------------------------------------------------------------------ */

export function verifyRun(store: Store, runId: string): { ok: boolean; checked: number; reason?: string } {
  const snaps = store.readSnapshots(runId);
  let prev: string | null = null;
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    if (s.seq !== i) return { ok: false, checked: i, reason: `snapshot ${i}: expected seq ${i}, found ${s.seq}` };
    if (s.prevHash !== prev) return { ok: false, checked: i, reason: `snapshot ${i} (${s.stepId}): prevHash does not match previous hash` };
    const h = hashSnapshot(s as unknown as Record<string, unknown>);
    if (h !== s.hash) return { ok: false, checked: i, reason: `snapshot ${i} (${s.stepId}): content hash mismatch (file was modified)` };
    prev = s.hash;
  }
  return { ok: true, checked: snaps.length };
}
