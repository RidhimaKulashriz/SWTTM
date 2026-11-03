import { z } from "zod";
import { diffRuns } from "../core/diff";
import { replayRun, runWorkflow, verifySnapshots } from "../core/engine";
import { MemoryStore } from "../core/memory-store";
import { Store, assertRunId } from "../core/store";
import { TmError, WorkflowSchema, type Executor, type Manifest, type Snapshot } from "../core/types";
import { listWorkflows, loadNamedWorkflow } from "../core/workflows";
import { createExecutor, mockLedger } from "../executors/executor";
import { emptyMockState, rebuildMockState, type MockState } from "../executors/mock";
import { detectBinary } from "../executors/swytchcode";
import { GitHubExecutor } from "../executors/github";
import { getStoredRun, listStoredRuns, listStoredRunsWithSnapshots, saveRun } from "../db/runs";
import { CONNECT_REQUIRED, type Access } from "./access";

const mem = globalThis as unknown as { __swytmMem?: MemoryStore };
/** Serverless hosts have a read-only disk, so they use one process-wide in-memory store (warm instances share it). */
export const store = (): Store => (process.env.VERCEL ? (mem.__swytmMem ??= new MemoryStore()) : new Store());
const databaseEnabled = () => process.env.NODE_ENV !== "test" && Boolean(process.env.DATABASE_URL);

const ANON: Access = { kind: "anonymous", ownerKey: "anonymous" };

/**
 * Connected visitors never touch the shared store: their runs live in a private per-request store and are
 * persisted under their own account key (or returned to their browser when there is no database).
 */
const privateAccess = (a: Access) => a.kind !== "anonymous";

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
    setTimeout(() => bus.delete(id), 120_000).unref?.();
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
/** A run sent back by the client so it can be replayed/verified on stateless hosts. Hash-chain verified before use. */
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
  return {
    ok: true,
    version: "0.3.0",
    executors: { swytchcode: detectBinary() ?? false, github: true },
    services: { postgres: Boolean(process.env.DATABASE_URL) },
    /** every visitor connects their own token; nothing is configured on the server */
    github: { connectYourOwn: true },
  };
}

/* ---- reading history ---- */
export async function listRuns(access: Access = ANON) {
  let runs: Manifest[];
  if (privateAccess(access)) runs = databaseEnabled() ? await listStoredRuns(access.ownerKey) : [];
  else runs = store().listRuns();
  return runs.map(({ workflow: _w, ...m }) => m);
}

export async function getRun(id: string, access: Access = ANON) {
  assertRunId(id);
  if (privateAccess(access)) {
    const stored = databaseEnabled() ? await getStoredRun(id, access.ownerKey) : null;
    if (!stored) throw new TmError(`Run "${id}" not found in your history`, 5);
    return stored;
  }
  const s = store();
  return { manifest: s.readManifest(id), snapshots: s.readSnapshots(id) };
}

export async function getStep(id: string, n: string, access: Access = ANON): Promise<Snapshot> {
  const { snapshots } = await getRun(id, access);
  const hit = snapshots.find((x) => String(x.stepIndex) === n || x.stepId === n);
  if (!hit) throw new TmError(`Step "${n}" not found in run ${id}`, 5);
  return hit;
}

export async function getDiff(a: string, b: string, ignore: string[], access: Access = ANON) {
  const [left, right] = await Promise.all([getRun(a, access), getRun(b, access)]);
  const strip = (x: Snapshot[]) => x.filter((s) => !s.stepId.endsWith(":compensate"));
  return diffRuns({ runId: a, steps: strip(left.snapshots) }, { runId: b, steps: strip(right.snapshots) }, { ignore });
}

function isDryRunOutput(output: unknown): boolean {
  return Boolean(output && typeof output === "object" && "dryRun" in output && (output as { dryRun?: unknown }).dryRun === true);
}

function countLedger(runs: { manifest: Manifest; snapshots: Snapshot[] }[]) {
  const ledger = { created: 0, deleted: 0, labeled: 0, unlabeled: 0, updated: 0, commented: 0 };
  for (const run of runs) {
    for (const snapshot of run.snapshots) {
      if (snapshot.status !== "ok" || isDryRunOutput(snapshot.output)) continue;
      const id = snapshot.canonicalId;
      if (id === "tracker.issue.create" || id === "github.issue.create") ledger.created++;
      if (id === "tracker.issue.delete" || id === "github.issue.comment.delete") ledger.deleted++;
      if (id === "tracker.issue.label" || id === "github.issue.labels.create") ledger.labeled++;
      if (id === "tracker.issue.unlabel" || id === "github.issue.labels.remove") ledger.unlabeled++;
      if (id === "tracker.issue.update" || id === "github.issue.update") ledger.updated++;
      if (id === "github.issue.comment.create") ledger.commented++;
    }
  }
  return { mock: runs.length > 0 && runs.every((run) => run.manifest.mock), ledger };
}

export async function getLedger(access: Access = ANON) {
  if (privateAccess(access)) return countLedger(databaseEnabled() ? await listStoredRunsWithSnapshots(access.ownerKey) : []);
  const s = store();
  if (s instanceof MemoryStore) return countLedger(s.listRuns().map((manifest) => ({ manifest, snapshots: s.readSnapshots(manifest.runId) })));
  const mock = mockLedger(s);
  return { mock: true, ledger: { ...mock, commented: 0 } };
}

/** Validate a client-supplied run (shape, hash chain, executor allowed for this caller) and load it into a private in-memory store. */
export function loadSeed(seed: Seed, access: Access = ANON): { store: MemoryStore; manifest: Manifest; snapshots: Snapshot[] } {
  const manifest = seed.manifest;
  const runId = assertRunId(String(manifest.runId));
  const live = manifest.executor === "github" && !manifest.mock;
  const offline = manifest.executor === "mock" && manifest.mock === true;
  if (!live && !offline) throw new TmError("Only GitHub and offline-simulator runs can be replayed from supplied data.", 2);
  if (live && access.kind === "anonymous") throw new TmError(CONNECT_REQUIRED, 2);
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

export async function getVerify(id: string, seed?: Seed, access: Access = ANON) {
  if (seed) return verifySnapshots(loadSeed(seed, access).snapshots);
  const { snapshots } = await getRun(id, access);
  return verifySnapshots([...snapshots].sort((a, b) => a.seq - b.seq));
}

export function workflows() {
  return listWorkflows();
}

export function resolveRunExecutor(body: z.infer<typeof RunBody>) {
  const workflow = WorkflowSchema.parse(loadNamedWorkflow(body.workflow));
  return body.executor ?? workflow.executor;
}

function exec(name: "mock" | "swytchcode" | "github", currentStore: Store, access: Access, mockState?: MockState): Executor {
  if (name === "swytchcode" && !detectBinary()) throw new TmError("swytchcode CLI not found on PATH; use executor=github", 2);
  if (name === "github") {
    if (access.kind === "connection") {
      const c = access.connection;
      return new GitHubExecutor({ token: c.token, owner: c.owner, repo: c.repo });
    }
    throw new TmError(CONNECT_REQUIRED, 2);
  }
  return createExecutor(name, currentStore, undefined, mockState);
}

async function persist(access: Access, manifest: Manifest, snapshots: Snapshot[]) {
  if (privateAccess(access) && databaseEnabled()) await saveRun(manifest, snapshots, access.ownerKey);
}

export async function startRun(body: z.infer<typeof RunBody>, opts: { access?: Access } = {}) {
  const access = opts.access ?? ANON;
  const currentStore: Store = privateAccess(access) ? new MemoryStore() : store();
  const wf = loadNamedWorkflow(body.workflow);
  const workflow = WorkflowSchema.parse(wf);
  const executorName = body.executor ?? workflow.executor;
  const executor = exec(executorName, currentStore, access, executorName === "mock" && currentStore instanceof MemoryStore ? emptyMockState() : undefined);
  try {
    const r = await runWorkflow(wf, {
      store: currentStore,
      executor,
      overrides: body.set,
      dryRun: body.dryRun,
      hooks: { onStep: (snap) => publish(body.streamId, { type: "step", data: snap }) },
    });
    publish(body.streamId, { type: "done", data: { runId: r.manifest.runId, outcome: r.manifest.outcome } });
    await persist(access, r.manifest, r.snapshots);
    return { runId: r.manifest.runId, outcome: r.manifest.outcome, executorCalls: r.executorCalls, manifest: r.manifest, snapshots: r.snapshots };
  } catch (e) {
    publish(body.streamId, { type: "done", data: { error: (e as Error).message } });
    throw e;
  }
}

/** Load a run (from this account's saved history or from verified client-supplied data) into a store replay can use. */
export async function loadReplaySource(id: string, seed: Seed | undefined, access: Access): Promise<Store> {
  if (seed) {
    const seeded = loadSeed(seed, access);
    if (seeded.manifest.runId !== id) throw new TmError("Supplied run id does not match the URL.", 2);
    return seeded.store;
  }
  if (privateAccess(access)) {
    const stored = databaseEnabled() ? await getStoredRun(id, access.ownerKey) : null;
    if (!stored) throw new TmError(`Run "${id}" not found in your history`, 5);
    const ms = new MemoryStore();
    ms.writeManifest(stored.manifest);
    for (const snapshot of [...stored.snapshots].sort((a, b) => a.seq - b.seq)) ms.writeSnapshot(snapshot);
    return ms;
  }
  const s = store();
  s.readManifest(id);
  return s;
}

export async function startReplay(id: string, body: z.infer<typeof ReplayBody>, opts: { access?: Access } = {}) {
  const access = opts.access ?? ANON;
  const s = await loadReplaySource(id, body.seed, access);
  const orig = s.readManifest(id);
  const mockState = orig.executor === "mock" && (body.seed || s instanceof MemoryStore) ? await rebuildMockState(s.readSnapshots(id)) : undefined;
  try {
    const r = await replayRun({
      store: s,
      executor: exec(orig.executor, s, access, mockState),
      runId: id,
      fromStep: body.fromStep,
      overrides: body.set,
      compensate: body.compensate,
      allowDuplicate: body.allowDuplicate,
      dryRun: body.dryRun,
      hooks: { onStep: (snap) => publish(body.streamId, { type: "step", data: snap }) },
    });
    publish(body.streamId, { type: "done", data: { runId: r.manifest.runId, outcome: r.manifest.outcome } });
    await persist(access, r.manifest, r.snapshots);
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
    const status = /^Invalid run id/.test(e.message) ? 400 : e.code === 5 ? 404 : e.code === 3 ? 409 : e.code === 2 ? (e.message === CONNECT_REQUIRED ? 401 : 400) : e.code === 4 ? 422 : e.code === 7 ? 503 : 500;
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
