import type { Manifest, Snapshot } from "../core/types";
import bundle from "../../examples/snapshots/demo.json";
import transcript from "../../examples/transcripts/demo.json";

export type RunData = { manifest: Manifest; snapshots: Snapshot[] };
export type Ledger = { created: number; deleted: number; labeled: number; unlabeled: number; updated: number };

export const demo = bundle as unknown as { source: string; runs: RunData[]; ledger: Ledger };
/** the original (failed) run from a real `swy-tm demo` execution against live GitHub */
export const heroRun = demo.runs[0];
export const transcriptLines = (transcript as { lines: string[] }).lines;
export const transcriptSource = (transcript as { source: string }).source;
