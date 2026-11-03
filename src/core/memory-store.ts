import { TmError, type Manifest, type Snapshot } from "./types";
import { assertRunId, Store } from "./store";

export class MemoryStore extends Store {
  private manifests = new Map<string, Manifest>();
  private snapshots = new Map<string, Snapshot[]>();

  override exists(runId: string): boolean {
    return this.manifests.has(assertRunId(runId));
  }

  override writeManifest(manifest: Manifest): void {
    this.manifests.set(assertRunId(manifest.runId), manifest);
  }

  override readManifest(runId: string): Manifest {
    const manifest = this.manifests.get(assertRunId(runId));
    if (!manifest) throw new TmError(`Run "${runId}" not found`, 5);
    return manifest;
  }

  override writeSnapshot(snapshot: Snapshot): void {
    const runId = assertRunId(snapshot.runId);
    const current = this.snapshots.get(runId) ?? [];
    current.push(snapshot);
    this.snapshots.set(runId, current);
  }

  override readSnapshots(runId: string): Snapshot[] {
    const snapshots = this.snapshots.get(assertRunId(runId));
    if (!snapshots) throw new TmError(`Run "${runId}" not found`, 5);
    return [...snapshots].sort((a, b) => a.seq - b.seq);
  }

  override readSteps(runId: string): Snapshot[] {
    return this.readSnapshots(runId).filter((snapshot) => !snapshot.stepId.endsWith(":compensate"));
  }

  override listRuns(): Manifest[] {
    return [...this.manifests.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
