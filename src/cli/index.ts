import { Command } from "commander";
import { spawn } from "node:child_process";
import { diffRuns } from "../core/diff";
import { replayRun, runWorkflow, verifyRun } from "../core/engine";
import { Store } from "../core/store";
import { TmError, type ExecutorName, type Snapshot } from "../core/types";
import { loadWorkflowFile } from "../core/workflows";
import { createExecutor, mockDbFile, mockLedger } from "../executors/executor";
import { MockExecutor } from "../executors/mock";
import { detectBinary, INSTALL_HINT } from "../executors/swytchcode";
import { fmtValue, label, paint, renderDiff, runLine, setColor, stepTable } from "./format";

const collect = (v: string, prev: string[]) => [...prev, v];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s = ""): void => {
  process.stdout.write(s + "\n");
};

const program = new Command();
program
  .name("swy-tm")
  .description("Time Machine: workflow-aware time-travel debugger on top of the Swytchcode CLI (independent prototype)")
  .version("0.1.0")
  .option("--dir <dir>", "snapshot directory", "timemachine")
  .option("--json", "machine-readable output")
  .option("--no-color", "disable colors");

const G = () => program.opts<{ dir: string; json?: boolean; color: boolean }>();
const store = () => {
  const o = G();
  if (!o.color) setColor(false);
  return new Store(o.dir);
};

function pickExecutor(s: Store, name: ExecutorName) {
  if (name === "swytchcode" && !detectBinary()) {
    throw new TmError(`swytchcode CLI not found on PATH. Install: ${INSTALL_HINT}\nOr run with --executor mock.`, 1);
  }
  return createExecutor(name, s);
}

/* ------------------------------ run ------------------------------ */
program
  .command("run <workflow>")
  .description("Execute all steps of a workflow and snapshot each one")
  .option("--set <k=v>", "override input (repeatable), e.g. inputs.finalState=closed", collect, [] as string[])
  .option("--executor <name>", "mock | swytchcode")
  .option("--run-id <id>", "explicit run id")
  .option("--dry-run", "pass --dry-run to the executor")
  .action(async (wf: string, o: { set: string[]; executor?: ExecutorName; runId?: string; dryRun?: boolean }) => {
    const s = store();
    const def = loadWorkflowFile(wf) as { executor?: ExecutorName };
    const exName = o.executor ?? def.executor ?? "mock";
    const ex = pickExecutor(s, exName);
    const r = await runWorkflow(def, { store: s, executor: ex, overrides: o.set, runId: o.runId, dryRun: o.dryRun });
    if (G().json) log(JSON.stringify({ manifest: r.manifest, snapshots: r.snapshots }, null, 2));
    else {
      log(paint.bold(`Run ${r.manifest.runId} — ${r.manifest.workflowId} — ${label(ex.mock)} executor${o.dryRun ? " (dry-run)" : ""}`));
      log(stepTable(r.snapshots));
      log(r.manifest.outcome === "ok" ? paint.green("outcome: ok") : paint.red(`outcome: failed at step ${r.manifest.failedStep}`));
      if (r.manifest.outcome === "failed") {
        log(`Next: swy-tm inspect ${r.manifest.runId} --step ${r.manifest.failedStep}`);
      }
    }
    process.exitCode = r.manifest.outcome === "ok" ? 0 : 1;
  });

/* ------------------------------ list ------------------------------ */
program
  .command("list")
  .description("List runs, newest first")
  .action(() => {
    const runs = store().listRuns();
    if (G().json) return log(JSON.stringify(runs.map(({ workflow: _w, ...m }) => m), null, 2));
    if (!runs.length) return log("No runs yet. Try: swy-tm demo   (or: swy-tm run workflows/demo-tracker.workflow.json)");
    log(paint.dim("RUN          WORKFLOW           OUTCOME PARENT       CREATED"));
    runs.forEach((m) => log(runLine(m)));
  });

/* ------------------------------ inspect ------------------------------ */
function showSnapshot(s: Snapshot) {
  log(paint.bold(`step ${s.stepIndex} "${s.stepId}"  ${s.canonicalId}  [${label(s.mock)}]`));
  log(`status: ${s.status}   side-effect: ${s.sideEffect}   duration: ${s.durationMs}ms   hash: ${s.hash.slice(0, 16)}…  prev: ${s.prevHash?.slice(0, 8) ?? "null"}`);
  log(`input:         ${JSON.stringify(s.input)}`);
  log(`resolvedInput: ${JSON.stringify(s.resolvedInput)}`);
  if (s.output !== undefined) log(`output:        ${JSON.stringify(s.output)}`);
  if (s.error) log(paint.red(`error:         ${JSON.stringify(s.error)}`));
  log(`contextAfter:  ${JSON.stringify(s.contextAfter)}`);
}
program
  .command("inspect <runId>")
  .description("Show the snapshot(s) of a run")
  .option("--step <n|id>", "one step")
  .action((runId: string, o: { step?: string }) => {
    const s = store();
    const m = s.readManifest(runId);
    let snaps = s.readSnapshots(runId);
    if (o.step !== undefined) {
      const hit = snaps.filter((x) => String(x.stepIndex) === o.step || x.stepId === o.step);
      if (!hit.length) throw new TmError(`Step "${o.step}" not found in ${runId}. Steps: ${m.steps.map((x) => `${x.index}:${x.id}`).join(", ")}`, 5);
      snaps = hit;
    }
    if (G().json) return log(JSON.stringify(o.step !== undefined ? snaps : { manifest: m, snapshots: snaps }, null, 2));
    log(paint.dim(`run ${m.runId} · ${m.workflowId} · outcome ${m.outcome}${m.parentRunId ? ` · parent ${m.parentRunId}` : ""}`));
    snaps.forEach((x) => {
      showSnapshot(x);
      log();
    });
  });

/* ------------------------------ replay ------------------------------ */
export async function doReplay(runId: string, o: Record<string, unknown>, s: Store) {
  const orig = s.readManifest(runId);
  const exName = (o.executor as ExecutorName | undefined) ?? orig.executor;
  const ex = pickExecutor(s, exName);
  const r = await replayRun({
    store: s,
    executor: ex,
    runId,
    fromStep: o.fromStep as string,
    overrides: (o.set as string[]) ?? [],
    compensate: !!o.compensate,
    allowDuplicate: !!o.allowDuplicate,
    dryRun: !!o.dryRun,
  });
  const d = diffRuns({ runId, steps: s.readSteps(runId) }, { runId: r.manifest.runId, steps: s.readSteps(r.manifest.runId) }, { ignore: (o.ignore as string[]) ?? [] });
  if (G().json) log(JSON.stringify({ manifest: r.manifest, executorCalls: r.executorCalls, injected: r.injected, compensated: r.compensated, diff: d }, null, 2));
  else {
    if (r.compensated.length) log(paint.yellow(`compensated (reverse order): ${r.compensated.join(", ")}`));
    log(renderDiff(d, { replay: r.manifest, mock: ex.mock, calls: r.executorCalls, injected: r.injected }));
    log(r.manifest.outcome === "ok" ? paint.green(`replay ${r.manifest.runId}: ok`) : paint.red(`replay ${r.manifest.runId}: failed at step ${r.manifest.failedStep}`));
  }
  return r;
}
program
  .command("replay <runId>")
  .description("Replay from a step, injecting recorded outputs for earlier steps")
  .requiredOption("--from-step <n|id>", "step index or id to start re-executing at")
  .option("--set <k=v>", "override (repeatable)", collect, [] as string[])
  .option("--compensate", "run compensation for already-applied side effects first")
  .option("--allow-duplicate", "allow repeating side effects")
  .option("--dry-run", "executor dry-run")
  .option("--executor <name>", "mock | swytchcode")
  .option("--ignore <glob>", "extra volatile path glob", collect, [] as string[])
  .action(async (runId: string, o: Record<string, unknown>) => {
    const r = await doReplay(runId, { ...o, fromStep: o.fromStep }, store());
    process.exitCode = r.manifest.outcome === "ok" ? 0 : 1;
  });

/* ------------------------------ diff ------------------------------ */
program
  .command("diff <runA> <runB>")
  .description("Divergence report between two runs")
  .option("--ignore <glob>", "extra volatile path glob", collect, [] as string[])
  .action((a: string, b: string, o: { ignore: string[] }) => {
    const s = store();
    const d = diffRuns({ runId: a, steps: s.readSteps(a) }, { runId: b, steps: s.readSteps(b) }, { ignore: o.ignore });
    if (G().json) return log(JSON.stringify(d, null, 2));
    log(renderDiff(d, { replay: s.readManifest(b), mock: s.readManifest(b).mock }));
  });

/* ------------------------------ verify ------------------------------ */
program
  .command("verify <runId>")
  .description("Re-compute the snapshot hash chain")
  .action((runId: string) => {
    const r = verifyRun(store(), runId);
    if (G().json) log(JSON.stringify(r));
    else log(r.ok ? paint.green(`chain OK (${r.checked} snapshots)`) : paint.red(`chain BROKEN: ${r.reason}`));
    process.exitCode = r.ok ? 0 : 1;
  });

/* ------------------------------ serve ------------------------------ */
program
  .command("serve")
  .description("Start the local debugger UI + API (Next.js, bound to 127.0.0.1)")
  .option("--port <port>", "port", "4173")
  .option("--open", "open the browser")
  .action(async (o: { port: string; open?: boolean }) => {
    const s = store();
    const env = { ...process.env, SWY_TM_DIR: s.root };
    const hasBuild = (await import("node:fs")).existsSync(".next/BUILD_ID");
    const args = [hasBuild ? "start" : "dev", "-H", "127.0.0.1", "-p", o.port];
    log(`Starting next ${args[0]} on http://127.0.0.1:${o.port}  (snapshots: ${s.root})${hasBuild ? "" : "  — no production build found, using dev server"}`);
    const p = spawn("npx", ["next", ...args], { stdio: "inherit", env });
    if (o.open) setTimeout(() => spawn(process.platform === "darwin" ? "open" : "xdg-open", [`http://127.0.0.1:${o.port}/app`], { stdio: "ignore", detached: true }).unref(), 2500);
    p.on("exit", (c) => process.exit(c ?? 0));
  });

/* ------------------------------ demo ------------------------------ */
program
  .command("demo")
  .description("Scripted end-to-end demo on the MOCK executor")
  .option("--fast", "no pauses")
  .action(async (o: { fast?: boolean }) => {
    const s = store();
    const pause = () => (o.fast || process.env.SWY_TM_FAST ? Promise.resolve() : sleep(600));
    const stage = async (n: number, t: string, cmd: string) => {
      await pause();
      log();
      log(paint.cyan(`━━ ${n}. ${t}`));
      log(paint.dim(`$ ${cmd}`));
    };
    new MockExecutor(mockDbFile(s)).reset();
    const ex = createExecutor("mock", s);
    const wf = loadWorkflowFile("demo-tracker");
    log(paint.bold("swy-tm demo — every executor result below is from the MOCK in-memory tracker, not a real API."));

    await stage(1, "Run the workflow (it will fail at step 2)", "swy-tm run workflows/demo-tracker.workflow.json");
    const r1 = await runWorkflow(wf, { store: s, executor: ex });
    const id1 = r1.manifest.runId;
    log(paint.bold(`Run ${id1} — MOCK executor`));
    log(stepTable(r1.snapshots));
    log(paint.red(`outcome: failed at step ${r1.manifest.failedStep}`));

    await stage(2, "Inspect what steps 0–1 left behind", `swy-tm inspect ${id1} --step 1`);
    showSnapshot(r1.snapshots[1]);

    await stage(3, "Replay from step 0 → side-effect guard aborts (nothing executed)", `swy-tm replay ${id1} --from-step 0 --set inputs.finalState=closed`);
    try {
      await replayRun({ store: s, executor: ex, runId: id1, fromStep: 0, overrides: ["inputs.finalState=closed"] });
    } catch (e) {
      if (e instanceof TmError && e.code === 3) log(paint.yellow(`${e.message}\n[exit 3]`));
      else throw e;
    }

    await stage(4, "Replay only the tail from step 2 with a fixed input", `swy-tm replay ${id1} --from-step 2 --set inputs.finalState=closed`);
    const r2 = await replayRun({ store: s, executor: ex, runId: id1, fromStep: 2, overrides: ["inputs.finalState=closed"] });
    const d2 = diffRuns({ runId: id1, steps: s.readSteps(id1) }, { runId: r2.manifest.runId, steps: s.readSteps(r2.manifest.runId) });
    log(renderDiff(d2, { replay: r2.manifest, mock: true, calls: r2.executorCalls, injected: r2.injected }));
    log(paint.bold(`ledger now (MOCK): ${JSON.stringify(mockLedger(s))}   ← 1 issue created, not 2`));

    await stage(5, "Full replay from step 0 with --compensate (undo, then redo)", `swy-tm replay ${id1} --from-step 0 --set inputs.finalState=closed --compensate`);
    const r3 = await replayRun({ store: s, executor: ex, runId: id1, fromStep: 0, overrides: ["inputs.finalState=closed"], compensate: true });
    log(paint.yellow(`compensated (reverse order): ${r3.compensated.join(", ")}`));
    const d3 = diffRuns({ runId: id1, steps: s.readSteps(id1) }, { runId: r3.manifest.runId, steps: s.readSteps(r3.manifest.runId) });
    log(renderDiff(d3, { replay: r3.manifest, mock: true, calls: r3.executorCalls, injected: r3.injected }));

    await stage(6, "Verify hash chains and show the ledger", `swy-tm verify ${r2.manifest.runId}`);
    for (const id of [id1, r2.manifest.runId, r3.manifest.runId]) log(`${id}: ${verifyRun(s, id).ok ? "chain OK" : "chain BROKEN"}`);
    const led = mockLedger(s);
    log(paint.bold(`side-effect ledger (MOCK): created=${led.created} deleted=${led.deleted} labeled=${led.labeled} unlabeled=${led.unlabeled}`));
    log(paint.dim(`demo runs: ${id1} (original), ${r2.manifest.runId} (tail replay), ${r3.manifest.runId} (compensated full replay)`));
    log(paint.dim(`UI: swy-tm serve --open   (or: npm run build && npx next start -H 127.0.0.1 -p 4173)`));
    void fmtValue;
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  if (e instanceof TmError) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(e.code);
  }
  process.stderr.write(`unexpected error: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
