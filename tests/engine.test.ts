import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { diffRuns } from "../src/core/diff";
import { applyOverrides, replayRun, runWorkflow, verifyRun } from "../src/core/engine";
import { Store } from "../src/core/store";
import { InterpolationError, TmError, type Executor, type Workflow } from "../src/core/types";
import { interpolate, redact } from "../src/core/util";
import { loadWorkflowFile } from "../src/core/workflows";
import { mockDbFile } from "../src/executors/executor";
import { MockExecutor } from "../src/executors/mock";

let dir: string;
let store: Store;
let mock: MockExecutor;
let calls: number;
let ex: Executor;
const wf = () => loadWorkflowFile("demo-tracker", path.resolve(__dirname, "..")) as Workflow;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swytm-"));
  store = new Store(dir);
  mock = new MockExecutor(mockDbFile(store));
  mock.reset();
  calls = 0;
  ex = {
    name: "mock",
    mock: true,
    exec: (id, input, ctx) => {
      calls++;
      return mock.exec(id, input, ctx);
    },
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function failedRun() {
  const r = await runWorkflow(wf(), { store, executor: ex });
  calls = 0;
  return r.manifest.runId;
}

describe("replay", () => {
  it("from step 2 calls the executor once and injects two steps", async () => {
    const id = await failedRun();
    const r = await replayRun({ store, executor: ex, runId: id, fromStep: 2, overrides: ["inputs.finalState=closed"] });
    expect(calls).toBe(1);
    expect(r.executorCalls).toBe(1);
    expect(r.injected).toBe(2);
    expect(r.snapshots.map((s) => s.status)).toEqual(["injected", "injected", "ok"]);
    expect(mock.ledger().created).toBe(1);
  });

  it("side-effect guard aborts with code 3 and executes nothing", async () => {
    const id = await failedRun();
    await expect(replayRun({ store, executor: ex, runId: id, fromStep: 0 })).rejects.toMatchObject({ code: 3 });
    expect(calls).toBe(0);
    expect(store.listRuns()).toHaveLength(1);
  });

  it("--compensate undoes in reverse order then replays (created:2 deleted:1)", async () => {
    const id = await failedRun();
    const r = await replayRun({ store, executor: ex, runId: id, fromStep: 0, overrides: ["inputs.finalState=closed"], compensate: true });
    expect(r.compensated).toEqual(["label", "create"]);
    expect(r.manifest.outcome).toBe("ok");
    const l = mock.ledger();
    expect(l.created).toBe(2);
    expect(l.deleted).toBe(1);
    expect(verifyRun(store, r.manifest.runId).ok).toBe(true);
  });

  it("aborts with 3 when a guarded step has no compensate", async () => {
    const w = wf() as { steps: { compensate?: unknown }[] };
    delete w.steps[1].compensate;
    const id = (await runWorkflow(w, { store, executor: ex })).manifest.runId;
    await expect(replayRun({ store, executor: ex, runId: id, fromStep: 0, compensate: true })).rejects.toMatchObject({ code: 3 });
  });

  it("rejects unknown override path (2) and unusable earlier snapshot (4)", async () => {
    const id = await failedRun();
    await expect(replayRun({ store, executor: ex, runId: id, fromStep: 2, overrides: ["inputs.nope=1"] })).rejects.toMatchObject({ code: 2 });
    await expect(replayRun({ store, executor: ex, runId: id, fromStep: 2, overrides: ["steps.close.input.body.nope=1"] })).rejects.toMatchObject({ code: 2 });
    const r2 = await replayRun({ store, executor: ex, runId: id, fromStep: 2, overrides: ["steps.close.input.body.state=closed"] });
    expect(r2.manifest.outcome).toBe("ok");
    // original run's step 2 failed → cannot replay from step 3+ ; fake by asking from 2 on a run whose step 1 is bad
    const bad = (await runWorkflow({ ...(wf() as object), inputs: { title: "", label: "bug", finalState: "open" } }, { store, executor: ex })).manifest.runId;
    await expect(replayRun({ store, executor: ex, runId: bad, fromStep: 2 })).rejects.toMatchObject({ code: 4 });
  });
});

describe("integrity", () => {
  it("hash chain verifies and tampering is detected", async () => {
    const id = await failedRun();
    expect(verifyRun(store, id).ok).toBe(true);
    const f = path.join(store.runDir(id), "step-01-label.json");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"bug"', '"bux"'));
    const v = verifyRun(store, id);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/hash mismatch/);
  });

  it("redacts sensitive keys at any depth", () => {
    const r = redact({ a: { Authorization: "Bearer x", nested: [{ api_key: "k", ok: 1 }] }, password: "p", secret: "s", token: "t", keep: "v" });
    expect(JSON.stringify(r)).not.toMatch(/Bearer x|"k"|"p"|"s"|"t"/);
    expect(r.keep).toBe("v");
    expect(r.a.nested[0].ok).toBe(1);
  });

  it("snapshots never contain secrets passed through inputs", async () => {
    const w = { id: "x", executor: "mock", inputs: { token: "ghp_SUPERSECRET0123456789" }, steps: [{ id: "a", canonical_id: "tracker.issue.create", input: { body: { title: "t", token: "{{inputs.token}}" } } }] };
    const id = (await runWorkflow(w, { store, executor: ex })).manifest.runId;
    const all = fs.readdirSync(store.runDir(id)).map((f) => fs.readFileSync(path.join(store.runDir(id), f), "utf8")).join("");
    expect(all).not.toContain("SUPERSECRET");
  });
});

describe("diff", () => {
  it("ignores volatile fields but reports the count", async () => {
    const id = await failedRun();
    const r = await replayRun({ store, executor: ex, runId: id, fromStep: 2, overrides: ["inputs.finalState=closed"] });
    const d = diffRuns({ runId: id, steps: store.readSteps(id) }, { runId: r.manifest.runId, steps: store.readSteps(r.manifest.runId) });
    expect(d.firstDivergence).toBe(2);
    expect(d.steps.map((s) => s.state)).toEqual(["identical", "identical", "diverged"]);
    expect(d.volatile.map((v) => v.path)).toContain("output.updated_at");
    const s2 = d.steps[2].changes.filter((c) => !c.volatile).map((c) => c.path);
    expect(s2).toContain("resolvedInput.body.state");
    expect(s2).toContain("output.state");
    expect(d.steps[2].changes.find((c) => c.path === "status")).toMatchObject({ before: "error", after: "ok" });
  });
});

describe("interpolation + overrides", () => {
  const ctx = { inputs: { n: 5, s: "x" }, steps: { a: { input: {}, output: { id: 7 } } } };
  it("preserves types for exact placeholders and stringifies embedded ones", () => {
    expect(interpolate("{{inputs.n}}", ctx, "t")).toBe(5);
    expect(interpolate("n={{inputs.n}}/{{steps.a.output.id}}", ctx, "t")).toBe("n=5/7");
    expect(interpolate({ k: ["{{steps.a.output.id}}"] }, ctx, "t")).toEqual({ k: [7] });
  });
  it("throws on unknown path naming template and step", () => {
    expect(() => interpolate("{{steps.zzz.output.id}}", ctx, "close")).toThrow(InterpolationError);
    expect(() => interpolate("{{steps.zzz.output.id}}", ctx, "close")).toThrow(/steps\.zzz\.output\.id.*close/);
  });
  it("validates override paths", () => {
    expect(() => applyOverrides(wf(), (wf() as { inputs: Record<string, unknown> }).inputs, ["inputs.missing=1"])).toThrow(TmError);
    const { inputs } = applyOverrides(wf(), (wf() as { inputs: Record<string, unknown> }).inputs, ["inputs.finalState=closed"]);
    expect(inputs.finalState).toBe("closed");
  });
});

describe("cli integration", () => {
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "--dir", dir, "--no-color", ...args], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    });

  it("run exits 1 with 3 snapshots, replay exits 0 with injected,injected,ok", () => {
    const r = cli(["run", "workflows/demo-tracker.workflow.json", "--run-id", "r_cli1"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("MOCK");
    expect(fs.readdirSync(path.join(dir, "r_cli1")).filter((f) => f.startsWith("step-"))).toHaveLength(3);
    const p = cli(["replay", "r_cli1", "--from-step", "2", "--set", "inputs.finalState=closed"]);
    expect(p.status).toBe(0);
    expect(p.stdout).toContain("executor calls: 1 (injected: 2)");
    const runs = JSON.parse(cli(["--json", "list"]).stdout) as { runId: string; parentRunId?: string }[];
    const child = runs.find((x) => x.parentRunId === "r_cli1")!;
    const statuses = fs.readdirSync(path.join(dir, child.runId)).filter((f) => f.startsWith("step-")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, child.runId, f), "utf8")).status);
    expect(statuses).toEqual(["injected", "injected", "ok"]);
    expect(cli(["replay", "r_cli1", "--from-step", "0"]).status).toBe(3);
    expect(cli(["replay", "r_cli1", "--from-step", "2", "--set", "inputs.zzz=1"]).status).toBe(2);
    expect(cli(["inspect", "r_nope"]).status).toBe(5);
    expect(cli(["verify", "r_cli1"]).status).toBe(0);
  }, 60000);
});
