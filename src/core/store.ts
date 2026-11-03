import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { TmError, type Manifest, type Snapshot } from "./types";
import { redact } from "./util";

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function assertRunId(id: string): string {
  if (!RUN_ID.test(id)) throw new TmError(`Invalid run id "${id}". Use letters, digits, "_" or "-". Try: swy-tm list`, 5);
  return id;
}

export function newRunId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const b = randomBytes(6);
  let s = "";
  for (const x of b) s += alphabet[x % alphabet.length];
  return `r_${s}`;
}

export class Store {
  readonly root: string;
  constructor(dir = process.env.SWY_TM_DIR || "timemachine") {
    this.root = path.resolve(dir);
  }

  runDir(runId: string): string {
    return path.join(this.root, assertRunId(runId));
  }

  exists(runId: string): boolean {
    return fs.existsSync(path.join(this.runDir(runId), "manifest.json"));
  }

  writeManifest(m: Manifest): void {
    const dir = this.runDir(m.runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(redact(m), null, 2));
  }

  readManifest(runId: string): Manifest {
    const f = path.join(this.runDir(runId), "manifest.json");
    if (!fs.existsSync(f)) throw new TmError(`Run "${runId}" not found in ${this.root}. Try: swy-tm list`, 5);
    return JSON.parse(fs.readFileSync(f, "utf8")) as Manifest;
  }

  writeSnapshot(s: Snapshot): void {
    const dir = this.runDir(s.runId);
    fs.mkdirSync(dir, { recursive: true });
    const nn = String(s.stepIndex).padStart(2, "0");
    const isComp = s.stepId.endsWith(":compensate");
    const name = isComp
      ? `comp-${String(s.seq).padStart(2, "0")}-${s.stepId.replace(":", "~")}.json`
      : `step-${nn}-${s.stepId}.json`;
    fs.writeFileSync(path.join(dir, name), JSON.stringify(s, null, 2));
  }

  /** all snapshots of a run, ordered by hash-chain position */
  readSnapshots(runId: string): Snapshot[] {
    const dir = this.runDir(runId);
    if (!fs.existsSync(dir)) throw new TmError(`Run "${runId}" not found in ${this.root}. Try: swy-tm list`, 5);
    return fs
      .readdirSync(dir)
      .filter((f) => /^(step|comp)-.*\.json$/.test(f))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Snapshot)
      .sort((a, b) => a.seq - b.seq);
  }

  /** main (non-compensation) snapshots, indexed by stepIndex */
  readSteps(runId: string): Snapshot[] {
    return this.readSnapshots(runId).filter((s) => !s.stepId.endsWith(":compensate"));
  }

  listRuns(): Manifest[] {
    if (!fs.existsSync(this.root)) return [];
    const out: Manifest[] = [];
    for (const d of fs.readdirSync(this.root)) {
      if (!RUN_ID.test(d)) continue;
      const f = path.join(this.root, d, "manifest.json");
      if (fs.existsSync(f)) out.push(JSON.parse(fs.readFileSync(f, "utf8")) as Manifest);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
