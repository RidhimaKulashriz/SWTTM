import type { Manifest, Snapshot } from "../core/types";
import { eq } from "drizzle-orm";
import { swytmRuns } from "./schema";

let ready: Promise<void> | undefined;

async function getPool() {
  const { pool } = await import("./index");
  return pool;
}

export function ensureRunTables(): Promise<void> {
  ready ??= getPool()
    .then((pool) =>
      pool.query(`
        CREATE TABLE IF NOT EXISTS swytm_runs (
          run_id TEXT PRIMARY KEY,
          manifest JSONB NOT NULL,
          snapshots JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        )
      `),
    )
    .then(() => undefined);
  return ready;
}

export async function saveRun(manifest: Manifest, snapshots: Snapshot[]): Promise<void> {
  await ensureRunTables();
  const { db } = await import("./index");
  await db
    .insert(swytmRuns)
    .values({
      runId: manifest.runId,
      manifest,
      snapshots,
      createdAt: new Date(manifest.createdAt),
    })
    .onConflictDoUpdate({
      target: swytmRuns.runId,
      set: { manifest, snapshots },
    });
}

export async function listStoredRuns(): Promise<Manifest[]> {
  await ensureRunTables();
  const { db } = await import("./index");
  const result = await db.select({ manifest: swytmRuns.manifest }).from(swytmRuns).orderBy(swytmRuns.createdAt);
  return result.reverse().map((row) => row.manifest as Manifest);
}

export async function listStoredRunsWithSnapshots(): Promise<{ manifest: Manifest; snapshots: Snapshot[] }[]> {
  await ensureRunTables();
  const { db } = await import("./index");
  const result = await db.select({ manifest: swytmRuns.manifest, snapshots: swytmRuns.snapshots }).from(swytmRuns);
  return result.map((row) => ({ manifest: row.manifest as Manifest, snapshots: row.snapshots as Snapshot[] }));
}

export async function getStoredRun(runId: string): Promise<{ manifest: Manifest; snapshots: Snapshot[] } | null> {
  await ensureRunTables();
  const { db } = await import("./index");
  const result = await db
    .select({ manifest: swytmRuns.manifest, snapshots: swytmRuns.snapshots })
    .from(swytmRuns)
    .where(eq(swytmRuns.runId, runId))
    .limit(1);
  const row = result[0];
  return row ? { manifest: row.manifest as Manifest, snapshots: row.snapshots as Snapshot[] } : null;
}
