import { z } from "zod";
import { diffRuns } from "../core/diff";
import { replayRun, runWorkflow, verifyRun } from "../core/engine";
import { MemoryStore } from "../core/memory-store";
import { Store } from "../core/store";
import { TmError, WorkflowSchema, type Snapshot } from "../core/types";
import { listWorkflows, loadNamedWorkflow } from "../core/workflows";
import { createExecutor, mockLedger } from "../executors/executor";
import { detectBinary } from "../executors/swytchcode";
import { githubCredentialsConfigured, githubReady } from "../executors/github";
import { getStoredRun, listStoredRuns, listStoredRunsWithSnapshots, saveRun } from "../db/runs";

export const store = () => (process.env.VERCEL ? new MemoryStore() : new Store());
const databaseEnabled = process.env.NODE_ENV !== "test" && Boolean(process.env.DATABASE_URL);

/* ---- tiny in-memory event bus for SSE (single Node process) ---- */
type Ev = { type: string; data: unknown };
type Chan = { events: Ev[]; subs: Set<(e: Ev) => void>; done: boolean };
const g = globalThis as unknown as { __swytmBus?: Map<string, Chan> };
const bus = (g.__swytmBus ??= new Map<string, Chan>());

export function channel(id: string): Chan {
  let c = bus.get(id);
  if (!c) {
    c = { events: [], subs: new Set(), done: false };
    bus.set(id, c);
    setTimeout(() => bus.delete(id), 60_000).unref?.();
  }
  return c;
}
export function publish(id: string | undefined, e: Ev) {
  if (!id) return;
  const c = channel(id);
  c.events.push(e);
  if (e.type === "done") c.done = true;
  c.subs.forEach((s) => s(e));
}

/* ---- validation ---- */
const SetList = z.array(z.string().min(3).max(500)).max(50).default([]);
const StreamId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional();
export const RunBody = z.object({
  workflow: z.string().regex(/^[A-Za-z0-9_-]+$/),
  set: SetList,
  executor: z.enum(["mock", "swytchcode", "github"]).optional(),
  dryRun: z.boolean().default(false),
  streamId: StreamId,
});
export const ReplayBody = z.object({
  fromStep: z.union([z.number().int().min(0), z.string().min(1).max(64)]),
  set: SetList,
  compensate: z.boolean().default(false),
  allowDuplicate: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  streamId: StreamId,
});

export function health() {
  const configured = githubCredentialsConfigured();
  return {
    ok: true,
    version: "0.1.0",
    executors: { mock: true, swytchcode: detectBinary() ?? false, github: githubReady() },
    services: {
      postgres: Boolean(process.env.DATABASE_URL),
    },
    github: {
      ready: githubReady(),
      repository: configured ? `${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}` : null,
    },
  };
}

export async function listRuns() {
  const runs = databaseEnabled ? await listStoredRuns() : store().listRuns();
  return runs.map(({ workflow: _w, ...m }) => m);
}

export async function getRun(id: string) {
  const s = store();
  const stored = databaseEnabled ? await getStoredRun(id) : null;
  if (stored) return stored;
  return { manifest: s.readManifest(id), snapshots: s.readSnapshots(id) };
}

export async function getStep(id: string, n: string): Promise<Snapshot> {
  const stored = databaseEnabled ? await getStoredRun(id) : null;
  if (stored) {
    const hit = stored.snapshots.find((x) => String(x.stepIndex) === n || x.stepId === n);
    if (!hit) throw new TmError(`Step "${n}" not found in run ${id}`, 5);
    return hit;
  }
  const hit = store()
    .readSteps(id)
    .find((x) => String(x.stepIndex) === n || x.stepId === n);
  if (!hit) throw new TmError(`Step "${n}" not found in run ${id}`, 5);
  return hit;
}

export async function getDiff(a: string, b: string, ignore: string[]) {
  const s = store();
  const [left, right] = databaseEnabled ? await Promise.all([getStoredRun(a), getStoredRun(b)]) : [null, null];
  return diffRuns(
    { runId: a, steps: left?.snapshots.filter((x) => !x.stepId.endsWith(":compensate")) ?? s.readSteps(a) },
    { runId: b, steps: right?.snapshots.filter((x) => !x.stepId.endsWith(":compensate")) ?? s.readSteps(b) },
    { ignore },
  );
}

function isDryRunOutput(output: unknown): boolean {
  return Boolean(output && typeof output === "object" && "dryRun" in output && (output as { dryRun?: unknown }).dryRun === true);
}

export async function getLedger() {
  if (!databaseEnabled) return { mock: true, ledger: mockLedger(store()) };
  const runs = await listStoredRunsWithSnapshots();
  const ledger = { created: 0, deleted: 0, labeled: 0, unlabeled: 0, updated: 0 };
  for (const run of runs) {
    for (const snapshot of run.snapshots) {
      if (snapshot.status !== "ok" || isDryRunOutput(snapshot.output)) continue;
      if (snapshot.canonicalId === "tracker.issue.create" || snapshot.canonicalId === "github.issue.create") ledger.created++;
      if (snapshot.canonicalId === "tracker.issue.delete") ledger.deleted++;
      if (snapshot.canonicalId === "tracker.issue.label" || snapshot.canonicalId === "github.issue.labels.create") ledger.labeled++;
      if (snapshot.canonicalId === "tracker.issue.unlabel") ledger.unlabeled++;
      if (snapshot.canonicalId === "tracker.issue.update" || snapshot.canonicalId === "github.issue.update") ledger.updated++;
    }
  }
  return { mock: runs.every((run) => run.manifest.mock), ledger };
}

export async function getVerify(id: string) {
  const stored = databaseEnabled ? await getStoredRun(id) : null;
  if (stored) {
    let prev: string | null = null;
    for (let i = 0; i < stored.snapshots.length; i++) {
      const current = stored.snapshots[i];
      if (current.seq !== i || current.prevHash !== prev) return { ok: false, checked: i };
      prev = current.hash;
    }
    return { ok: true, checked: stored.snapshots.length };
  }
  return verifyRun(store(), id);
}

export function workflows() {
  return listWorkflows();
}

export function resolveRunExecutor(body: z.infer<typeof RunBody>) {
  const workflow = WorkflowSchema.parse(loadNamedWorkflow(body.workflow));
  return body.executor ?? workflow.executor;
}

function exec(name: "mock" | "swytchcode" | "github", currentStore: Store) {
  if (name === "swytchcode" && !detectBinary()) throw new TmError("swytchcode CLI not found on PATH; use executor=mock", 2);
  if (name === "github" && !githubReady()) throw new TmError("Live GitHub execution requires GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, Neon Auth, an allowed email, and PostgreSQL configuration.", 7);
  return createExecutor(name, currentStore);
}

export async function startRun(body: z.infer<typeof RunBody>) {
  const currentStore = store();
  const wf = loadNamedWorkflow(body.workflow);
  const workflow = WorkflowSchema.parse(wf);
  const executorName = body.executor ?? workflow.executor;
  const r = await runWorkflow(wf, {
    store: currentStore,
    executor: exec(executorName, currentStore),
    overrides: body.set,
    dryRun: body.dryRun,
    hooks: { onStep: (snap) => publish(body.streamId, { type: "step", data: snap }) },
  });
  publish(body.streamId, { type: "done", data: { runId: r.manifest.runId, outcome: r.manifest.outcome } });
  if (databaseEnabled) await saveRun(r.manifest, r.snapshots);
  return { runId: r.manifest.runId, outcome: r.manifest.outcome, executorCalls: r.executorCalls };
}

export async function startReplay(id: string, body: z.infer<typeof ReplayBody>) {
  const s = store();
  const stored = databaseEnabled ? await getStoredRun(id) : null;
  if (stored) {
    s.writeManifest(stored.manifest);
    for (const snapshot of stored.snapshots) s.writeSnapshot(snapshot);
  }
  const orig = s.readManifest(id);
  try {
    const r = await replayRun({
      store: s,
      executor: exec(orig.executor, s),
      runId: id,
      fromStep: body.fromStep,
      overrides: body.set,
      compensate: body.compensate,
      allowDuplicate: body.allowDuplicate,
      dryRun: body.dryRun,
      hooks: { onStep: (snap) => publish(body.streamId, { type: "step", data: snap }) },
    });
    publish(body.streamId, { type: "done", data: { runId: r.manifest.runId, outcome: r.manifest.outcome } });
    if (databaseEnabled) await saveRun(r.manifest, r.snapshots);
    return {
      runId: r.manifest.runId,
      outcome: r.manifest.outcome,
      executorCalls: r.executorCalls,
      injected: r.injected,
      compensated: r.compensated,
      diff: diffRuns({ runId: id, steps: s.readSteps(id) }, { runId: r.manifest.runId, steps: s.readSteps(r.manifest.runId) }),
    };
  } catch (e) {
    publish(body.streamId, { type: "done", data: { error: (e as Error).message } });
    throw e;
  }
}

/* ---- HTTP helpers ---- */
export function errorResponse(e: unknown): Response {
  if (e instanceof z.ZodError) {
    return Response.json({ error: "Invalid request", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
  }
  if (e instanceof TmError) {
    const status = /^Invalid run id/.test(e.message) ? 400 : e.code === 5 ? 404 : e.code === 3 ? 409 : e.code === 2 ? 400 : e.code === 4 ? 422 : e.code === 7 ? 503 : 500;
    return Response.json({ error: e.message, code: e.code, details: e.details }, { status });
  }
  return Response.json({ error: (e as Error).message ?? "internal error" }, { status: 500 });
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new TmError("Request body must be valid JSON", 2);
  }
}
