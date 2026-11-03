import type { Manifest, Snapshot } from "../core/types";
import { and, desc, eq } from "drizzle-orm";
import { swytmRuns } from "./schema";

let ready: Promise<void> | undefined;

async function getPool() {
  const { pool } = await import("./index");
  return pool;
}

export function ensureRunTables(): Promise<void> {
  ready ??= getPool()
    .then(async (pool) => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS swytm_runs (
          run_id TEXT PRIMARY KEY,
          manifest JSONB NOT NULL,
          snapshots JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          owner_key TEXT NOT NULL DEFAULT 'anonymous'
        )
      `);
      await pool.query(`ALTER TABLE swytm_runs ADD COLUMN IF NOT EXISTS owner_key TEXT NOT NULL DEFAULT 'anonymous'`);
      await pool.query(`CREATE INDEX IF NOT EXISTS swytm_runs_owner_idx ON swytm_runs (owner_key, created_at DESC)`);
    })
    .catch((e) => {
      ready = undefined;
      throw e;
    });
  return ready;
}

export async function saveRun(manifest: Manifest, snapshots: Snapshot[], ownerKey: string): Promise<void> {
  await ensureRunTables();
  const { db } = await import("./index");
  await db
    .insert(swytmRuns)
    .values({
      runId: manifest.runId,
      manifest,
      snapshots,
      createdAt: new Date(manifest.createdAt),
      ownerKey,
    })
    .onConflictDoUpdate({
      target: swytmRuns.runId,
      set: { manifest, snapshots },
      setWhere: eq(swytmRuns.ownerKey, ownerKey),
    });
}

export async function listStoredRuns(ownerKey: string): Promise<Manifest[]> {
  await ensureRunTables();
  const { db } = await import("./index");
  const result = await db
    .select({ manifest: swytmRuns.manifest })
    .from(swytmRuns)
    .where(eq(swytmRuns.ownerKey, ownerKey))
    .orderBy(desc(swytmRuns.createdAt))
    .limit(200);
  return result.map((row) => row.manifest as Manifest);
}

export async function listStoredRunsWithSnapshots(ownerKey: string): Promise<{ manifest: Manifest; snapshots: Snapshot[] }[]> {
  await ensureRunTables();
  const { db } = await import("./index");
  const result = await db
    .select({ manifest: swytmRuns.manifest, snapshots: swytmRuns.snapshots })
    .from(swytmRuns)
    .where(eq(swytmRuns.ownerKey, ownerKey))
    .orderBy(desc(swytmRuns.createdAt))
    .limit(500);
  return result.map((row) => ({ manifest: row.manifest as Manifest, snapshots: row.snapshots as Snapshot[] }));
}

export async function getStoredRun(runId: string, ownerKey: string): Promise<{ manifest: Manifest; snapshots: Snapshot[] } | null> {
  await ensureRunTables();
  const { db } = await import("./index");
  const result = await db
    .select({ manifest: swytmRuns.manifest, snapshots: swytmRuns.snapshots })
    .from(swytmRuns)
    .where(and(eq(swytmRuns.runId, runId), eq(swytmRuns.ownerKey, ownerKey)))
    .limit(1);
  const row = result[0];
  return row ? { manifest: row.manifest as Manifest, snapshots: row.snapshots as Snapshot[] } : null;
}
