import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/core/memory-store";
import { replayRun, runWorkflow } from "../src/core/engine";
import type { ExecResult, Executor } from "../src/core/types";
import { loadNamedWorkflow } from "../src/core/workflows";
import { leaves, planReplay, resolvedWithSources } from "../src/web/plan";

/** Stands in for GitHub: same outputs, 422 for a bad state. */
function stub(): Executor & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "github",
    mock: false,
    calls,
    async exec(id, input): Promise<ExecResult> {
      calls.push(id);
      const body = (input as { body?: { state?: string } }).body;
      if (id === "github.issue.update" && body?.state !== "open" && body?.state !== "closed") {
        return { ok: false, error: { category: "validation", message: "GitHub API 422: Validation Failed" } };
      }
      if (id === "github.issue.create") return { ok: true, output: { number: 7, state: "open", title: "t" } };
      if (id === "github.issue.labels.create") return { ok: true, output: { number: 7, labels: ["bug"] } };
      return { ok: true, output: { number: 7, state: body?.state } };
    },
  };
}

async function failedRun() {
  const store = new MemoryStore();
  const executor = stub();
  const run = await runWorkflow(loadNamedWorkflow("github-issue"), {
    store,
    executor,
    overrides: ['inputs.owner="o"', 'inputs.repo="r"', 'inputs.finalState="pending"'],
  });
  return { store, executor, run };
}

describe("replay plan predicts what the engine does", () => {
  it("replay from the failing step: 2 reused, 1 call, no guard", async () => {
    const { store, run } = await failedRun();
    expect(run.manifest.outcome).toBe("failed");
    const plan = planReplay(run.manifest, run.snapshots, { from: 2, overrides: ["inputs.finalState=closed"], compensate: false, allowDuplicate: false, dryRun: false });
    expect(plan).toMatchObject({ reused: 2, calls: 1, blocked: false, unusable: null });
    expect(plan.changes[0]).toMatchObject({ path: "inputs.finalState", before: "pending", after: "closed", known: true });
    expect(plan.rows.map((r) => r.action)).toEqual(["reuse", "reuse", "run"]);

    const real = await replayRun({ store, executor: stub(), runId: run.manifest.runId, fromStep: 2, overrides: ["inputs.finalState=closed"] });
    expect(real.executorCalls).toBe(plan.calls);
    expect(real.injected).toBe(plan.reused);
  });

  it("replay from step 0 is blocked by the guard, and compensate predicts undo calls", async () => {
    const { store, run } = await failedRun();
    const blocked = planReplay(run.manifest, run.snapshots, { from: 0, overrides: [], compensate: false, allowDuplicate: false, dryRun: false });
    expect(blocked.blocked).toBe(true);
    expect(blocked.guarded).toEqual(["0:create", "1:label"]);
    await expect(replayRun({ store, executor: stub(), runId: run.manifest.runId, fromStep: 0 })).rejects.toMatchObject({ code: 3 });

    const comp = planReplay(run.manifest, run.snapshots, { from: 0, overrides: ["inputs.finalState=closed"], compensate: true, allowDuplicate: false, dryRun: false });
    expect(comp).toMatchObject({ blocked: false, undone: 2, calls: 5 });
    const real = await replayRun({ store, executor: stub(), runId: run.manifest.runId, fromStep: 0, overrides: ["inputs.finalState=closed"], compensate: true });
    expect(real.executorCalls).toBe(comp.calls);
  });

  it("plan only never blocks and makes no calls to repeat", async () => {
    const { run } = await failedRun();
    const plan = planReplay(run.manifest, run.snapshots, { from: 0, overrides: [], compensate: false, allowDuplicate: false, dryRun: true });
    expect(plan.blocked).toBe(false);
    expect(plan.rows.every((r) => r.action === "preview")).toBe(true);
  });
});

describe("snapshot reader", () => {
  it("shows where each resolved value came from", async () => {
    const { run } = await failedRun();
    const label = run.snapshots[1];
    const rows = resolvedWithSources(run.manifest.workflow.steps[1].input, label.resolvedInput);
    const by = Object.fromEntries(rows.map((r) => [r.path, r]));
    expect(by["issue_number"]).toMatchObject({ value: 7, source: { kind: "step", ref: "steps.create.output.number", stepId: "create" } });
    expect(by["owner"].source).toEqual({ kind: "input", ref: "inputs.owner" });
    expect(by["body.labels.0"].source).toEqual({ kind: "input", ref: "inputs.label" });
    expect(leaves({ a: { b: [1, 2] }, c: {} }).map((l) => l.path)).toEqual(["a.b.0", "a.b.1", "c"]);
  });
});
