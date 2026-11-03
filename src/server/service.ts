import { z } from "zod";
import { diffRuns } from "../core/diff";
import { replayRun, runWorkflow, verifyRun, verifySnapshots } from "../core/engine";
import { MemoryStore } from "../core/memory-store";
import { Store, assertRunId } from "../core/store";
import { TmError, WorkflowSchema, type Manifest, type Snapshot } from "../core/types";
import { listWorkflows, loadNamedWorkflow } from "../core/workflows";
import { createExecutor, mockLedger } from "../executors/executor";
import { emptyMockState, rebuildMockState, type MockState } from "../executors/mock";
import { detectBinary } from "../executors/swytchcode";
import { githubCredentialsConfigured, githubReady } from "../executors/github";
import { getStoredRun, listStoredRuns, listStoredRunsWithSnapshots, saveRun } from "../db/runs";

const mem = globalThis as unknown as { __swytmMem?: MemoryStore };
/** Serverless hosts have a read-only disk, so they use one process-wide in-memory store (warm instances share it). */
export const store = (): Store => (process.env.VERCEL ? (mem.__swytmMem ??= new MemoryStore()) : new Store());
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
/** A mock run sent back by the client so it can be replayed/verified on stateless hosts and without sign-in. */
export const SeedSchema = z.object({
  manifest: z.custom<Manifest>((v) => Boolean(v) && typeof v === "object"),
  snapshots: z.array(z.custom<Snapshot>((v) => Boolean(v) && typeof v === "object")).min(1).max(200),
});
export type Seed = z.infer<typeof SeedSchema>;
export const VerifyBody = z.object({ seed: SeedSchema.optional() });

export const ReplayBody = z.object({
  fromStep: z.union([z.number().int().min(0), z.string().min(1).max(64)]),
  set: SetList,
  compensate: z.boolean().default(false),
  allowDuplicate: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  streamId: StreamId,
  seed: SeedSchema.optional(),
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

function countLedger(runs: { manifest: Manifest; snapshots: Snapshot[] }[]) {
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

export async function getLedger() {
  if (!databaseEnabled) {
    const s = store();
    // serverless: the fake tracker has no file, so count the side effects recorded in the in-memory runs
    if (s instanceof MemoryStore) return countLedger(s.listRuns().map((manifest) => ({ manifest, snapshots: s.readSnapshots(manifest.runId) })));
    return { mock: true, ledger: mockLedger(s) };
  }
  return countLedger(await listStoredRunsWithSnapshots());
}

/** Validate a client-supplied mock run (shape, mock-only, hash chain) and load it into a private in-memory store. */
export function loadSeed(seed: Seed): { store: MemoryStore; manifest: Manifest; snapshots: Snapshot[] } {
  const manifest = seed.manifest;
  const runId = assertRunId(String(manifest.runId));
  if (manifest.executor !== "mock" || manifest.mock !== true) {
    throw new TmError("Only mock-executor runs can be replayed or verified without signing in.", 2);
  }
  WorkflowSchema.parse(manifest.workflow);
  const ordered = [...seed.snapshots].sort((a, b) => a.seq - b.seq);
  if (ordered.some((x) => x.runId !== runId)) throw new TmError("Snapshots do not belong to the supplied run.", 4);
  const check = verifySnapshots(ordered);
  if (!check.ok) throw new TmError(`Supplied run failed hash-chain verification: ${check.reason}`, 4);
  const ms = new MemoryStore();
  ms.writeManifest(manifest);
  for (const snap of ordered) ms.writeSnapshot(snap);
  return { store: ms, manifest, snapshots: ordered };
}

export async function getVerify(id: string, seed?: Seed) {
  if (seed) return verifySnapshots(loadSeed(seed).snapshots);
  const stored = databaseEnabled ? await getStoredRun(id) : null;
  if (stored) return verifySnapshots([...stored.snapshots].sort((a, b) => a.seq - b.seq));
  return verifyRun(store(), id);
}

export function workflows() {
  return listWorkflows();
}

export function resolveRunExecutor(body: z.infer<typeof RunBody>) {
  const workflow = WorkflowSchema.parse(loadNamedWorkflow(body.workflow));
  return body.executor ?? workflow.executor;
}

function exec(name: "mock" | "swytchcode" | "github", currentStore: Store, mockState?: MockState) {
  if (name === "swytchcode" && !detectBinary()) throw new TmError("swytchcode CLI not found on PATH; use executor=mock", 2);
  if (name === "github" && !githubReady()) throw new TmError("Live GitHub execution requires GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, Neon Auth, an allowed email, and PostgreSQL configuration.", 7);
  return createExecutor(name, currentStore, undefined, mockState);
}

export async function startRun(body: z.infer<typeof RunBody>, opts: { persist?: boolean } = {}) {
  const persist = opts.persist ?? true;
  const currentStore = store();
  const wf = loadNamedWorkflow(body.workflow);
  const workflow = WorkflowSchema.parse(wf);
  const executorName = body.executor ?? workflow.executor;
  const r = await runWorkflow(wf, {
    store: currentStore,
    // in-memory MemoryStore (serverless) => in-memory fake tracker; file store => file-backed tracker
    executor: exec(executorName, currentStore, executorName === "mock" && currentStore instanceof MemoryStore ? emptyMockState() : undefined),
    overrides: body.set,
    dryRun: body.dryRun,
    hooks: { onStep: (snap) => publish(body.streamId, { type: "step", data: snap }) },
  });
  publish(body.streamId, { type: "done", data: { runId: r.manifest.runId, outcome: r.manifest.outcome } });
  if (databaseEnabled && persist) await saveRun(r.manifest, r.snapshots);
  return { runId: r.manifest.runId, outcome: r.manifest.outcome, executorCalls: r.executorCalls, manifest: r.manifest, snapshots: r.snapshots };
}

export async function startReplay(id: string, body: z.infer<typeof ReplayBody>, opts: { persist?: boolean } = {}) {
  let s: Store;
  let fromDb = false;
  const persist = opts.persist ?? true;
  if (body.seed) {
    // stateless path: the client supplied the (verified, mock-only) run
    const seeded = loadSeed(body.seed);
    if (seeded.manifest.runId !== id) throw new TmError("Supplied run id does not match the URL.", 2);
    s = seeded.store;
  } else {
    s = store();
    const stored = databaseEnabled ? await getStoredRun(id) : null;
    if (stored) {
      fromDb = true;
      s.writeManifest(stored.manifest);
      const have = new Set<number>();
      try {
        for (const x of s.readSnapshots(id)) have.add(x.seq);
      } catch {
        /* run not in the local store yet */
      }
      for (const snapshot of [...stored.snapshots].sort((a, b) => a.seq - b.seq)) if (!have.has(snapshot.seq)) s.writeSnapshot(snapshot);
    }
  }
  const orig = s.readManifest(id);
  const mockState =
    orig.executor === "mock" && (body.seed || fromDb || s instanceof MemoryStore) ? await rebuildMockState(s.readSnapshots(id)) : undefined;
  try {
    const r = await replayRun({
      store: s,
      executor: exec(orig.executor, s, mockState),
      runId: id,
      fromStep: body.fromStep,
      overrides: body.set,
      compensate: body.compensate,
      allowDuplicate: body.allowDuplicate,
      dryRun: body.dryRun,
      hooks: { onStep: (snap) => publish(body.streamId, { type: "step", data: snap }) },
    });
    publish(body.streamId, { type: "done", data: { runId: r.manifest.runId, outcome: r.manifest.outcome } });
    if (databaseEnabled && persist) await saveRun(r.manifest, r.snapshots);
    return {
      runId: r.manifest.runId,
      outcome: r.manifest.outcome,
      executorCalls: r.executorCalls,
      injected: r.injected,
      compensated: r.compensated,
      manifest: r.manifest,
      snapshots: r.snapshots,
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
