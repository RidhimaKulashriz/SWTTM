import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const swytmRuns = pgTable("swytm_runs", {
  runId: text("run_id").primaryKey(),
  manifest: jsonb("manifest").notNull(),
  snapshots: jsonb("snapshots").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  /** who may read/replay this run: `gh:<github user id>` for a connected account, `server` for the configured owner */
  ownerKey: text("owner_key").notNull().default("anonymous"),
});
