import fs from "node:fs";
import path from "node:path";
import type { ExecResult, Executor, Snapshot } from "../core/types";

export type Ledger = { created: number; deleted: number; labeled: number; unlabeled: number; updated: number };
type Issue = { id: number; title: string; state: "open" | "closed"; labels: string[]; created_at: string };
export type MockState = { nextId: number; issues: Record<string, Issue>; ledger: Ledger };
type Db = MockState;

export const emptyMockState = (): MockState => ({
  nextId: 1,
  issues: {},
  ledger: { created: 0, deleted: 0, labeled: 0, unlabeled: 0, updated: 0 },
});

type In = { path?: { id?: unknown }; body?: Record<string, unknown> };

/** MOCK executor: an in-memory (file-persisted) fake issue tracker. Not a real API. */
export class MockExecutor implements Executor {
  name = "mock" as const;
  mock = true;
  constructor(private file: string, private state?: MockState) {}

  private load(): Db {
    if (this.state) return this.state;
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as Db;
    } catch {
      return emptyMockState();
    }
  }
  private save(db: Db) {
    if (this.state) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(db, null, 2));
  }

  ledger(): Ledger {
    return this.load().ledger;
  }
  reset() {
    this.save(emptyMockState());
  }

  async exec(canonicalId: string, input: unknown, ctx: { dryRun: boolean }): Promise<ExecResult> {
    if (ctx.dryRun) return { ok: true, output: { dryRun: true, wouldCall: canonicalId, withInput: input } };
    const db = this.load();
    const i = (input ?? {}) as In;
    const key = String(i.path?.id ?? "");
    const notFound = (): ExecResult => ({
      ok: false,
      error: { category: "not_found", message: `issue ${key} not found`, retryable: false, suggestedAction: "check the id" },
    });
    let res: ExecResult;
    switch (canonicalId) {
      case "tracker.issue.create": {
        const title = i.body?.title;
        if (typeof title !== "string" || !title) {
          return { ok: false, error: { category: "validation", message: "title is required", retryable: false } };
        }
        const issue: Issue = { id: db.nextId++, title, state: "open", labels: [], created_at: new Date().toISOString() };
        db.issues[String(issue.id)] = issue;
        db.ledger.created++;
        res = { ok: true, output: { ...issue } };
        break;
      }
      case "tracker.issue.label": {
        const it = db.issues[key];
        if (!it) return notFound();
        const label = String(i.body?.label ?? "");
        if (!it.labels.includes(label)) it.labels.push(label);
        db.ledger.labeled++;
        res = { ok: true, output: { id: it.id, labels: [...it.labels] } };
        break;
      }
      case "tracker.issue.unlabel": {
        const it = db.issues[key];
        if (!it) return notFound();
        it.labels = it.labels.filter((l) => l !== String(i.body?.label ?? ""));
        db.ledger.unlabeled++;
        res = { ok: true, output: { id: it.id, labels: [...it.labels] } };
        break;
      }
      case "tracker.issue.update": {
        const it = db.issues[key];
        if (!it) return notFound();
        const state = i.body?.state;
        if (state !== "open" && state !== "closed") {
          return {
            ok: false,
            error: {
              category: "validation",
              message: `invalid_state: '${String(state)}' is not one of open,closed`,
              retryable: false,
              suggestedAction: "use open or closed",
              raw: { status: 422 },
            },
          };
        }
        it.state = state;
        db.ledger.updated++;
        res = { ok: true, output: { id: it.id, title: it.title, state: it.state, labels: [...it.labels], updated_at: new Date().toISOString() } };
        break;
      }
      case "tracker.issue.delete": {
        if (!db.issues[key]) return notFound();
        delete db.issues[key];
        db.ledger.deleted++;
        res = { ok: true, output: { id: Number(key), deleted: true } };
        break;
      }
      default:
        return { ok: false, error: { category: "unknown_tool", message: `mock executor has no tool "${canonicalId}"`, retryable: false } };
    }
    this.save(db);
    return res;
  }
}

/**
 * Rebuild the fake tracker's state (issues + ledger) by re-applying a run's recorded side effects in order.
 * This lets a run be replayed on stateless hosts (serverless, read-only disks) without any file on disk.
 */
export async function rebuildMockState(snapshots: Snapshot[]): Promise<MockState> {
  const state = emptyMockState();
  const ex = new MockExecutor("", state);
  for (const snap of [...snapshots].sort((a, b) => a.seq - b.seq)) {
    if ((snap.status !== "ok" && snap.status !== "injected") || !snap.sideEffect) continue;
    const out = snap.output as { dryRun?: unknown } | null | undefined;
    if (out && typeof out === "object" && out.dryRun === true) continue;
    // keep recorded ids stable, even when this run's parent (which created the issue) is not part of the supplied data
    const recordedId = (snap.output as { id?: unknown } | null | undefined)?.id;
    if (snap.canonicalId === "tracker.issue.create" && typeof recordedId === "number") state.nextId = recordedId;
    await ex.exec(snap.canonicalId, snap.resolvedInput, { dryRun: false });
    state.nextId = Math.max(state.nextId, ...Object.keys(state.issues).map((k) => Number(k) + 1), 1);
  }
  return state;
}
