import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Manifest, Snapshot } from "../src/core/types";

let dir: string;
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
type Run = { runId: string; manifest: Manifest; snapshots: Snapshot[] };

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swytm-stateless-"));
  process.env.SWY_TM_DIR = dir;
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("stateless debugging (no history on the server, no sign-in)", () => {
  it("run response carries the full run; seeded verify/replay/compensate work and tampering is rejected", async () => {
    const runs = await import("../src/app/api/runs/route");
    const replay = await import("../src/app/api/runs/[id]/replay/route");
    const verify = await import("../src/app/api/runs/[id]/verify/route");

    const created = await runs.POST(post({ workflow: "demo-tracker", executor: "mock" }));
    expect(created.status).toBe(201);
    const run = (await created.json()) as Run;
    expect(run.snapshots).toHaveLength(3);
    const seed = { manifest: run.manifest, snapshots: run.snapshots };

    const v = await verify.POST(post({ seed }), ctx({ id: run.runId }));
    expect(await v.json()).toMatchObject({ ok: true, checked: 3 });

    // side-effect guard still protects
    expect((await replay.POST(post({ fromStep: 1, seed }), ctx({ id: run.runId }))).status).toBe(409);

    // replay the tail only: one executor call, two injected steps
    const ok = await replay.POST(post({ fromStep: 2, set: ["inputs.finalState=closed"], seed }), ctx({ id: run.runId }));
    expect(ok.status).toBe(201);
    const okBody = (await ok.json()) as { outcome: string; executorCalls: number; injected: number; snapshots: Snapshot[]; manifest: Manifest };
    expect(okBody).toMatchObject({ outcome: "ok", executorCalls: 1, injected: 2 });
    expect(okBody.snapshots.map((s) => s.status)).toEqual(["injected", "injected", "ok"]);

    // replaying a replay (state is rebuilt from the supplied snapshots only)
    const child = { manifest: okBody.manifest, snapshots: okBody.snapshots };
    const again = await replay.POST(post({ fromStep: 2, allowDuplicate: true, set: ["inputs.finalState=open"], seed: child }), ctx({ id: okBody.manifest.runId }));
    expect(((await again.json()) as { outcome: string }).outcome).toBe("ok");

    // compensate + full re-run
    const comp = await replay.POST(post({ fromStep: 0, compensate: true, set: ["inputs.finalState=closed"], seed }), ctx({ id: run.runId }));
    expect(comp.status).toBe(201);
    expect(((await comp.json()) as { compensated: string[] }).compensated).toEqual(["label", "create"]);

    // tampered data is rejected with the reason
    const bad = structuredClone(seed);
    bad.snapshots[1].output = { hacked: true };
    const t = await verify.POST(post({ seed: bad }), ctx({ id: run.runId }));
    expect(t.status).toBe(422);
    expect(((await t.json()) as { error: string }).error).toMatch(/content hash mismatch/);
    expect((await replay.POST(post({ fromStep: 2, seed: bad }), ctx({ id: run.runId }))).status).toBe(422);

    // only mock runs may be supplied by the client
    const real = structuredClone(seed);
    real.manifest.executor = "github";
    expect((await replay.POST(post({ fromStep: 2, seed: real }), ctx({ id: run.runId }))).status).toBe(400);
  });
});
