import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dir: string;
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const post = (body: unknown) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swytm-srv-"));
  process.env.SWY_TM_DIR = dir;
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("api routes", () => {
  it("run → get → replay(409 guard) → compensate → diff → ledger → verify", async () => {
    const runs = await import("../src/app/api/runs/route");
    const one = await import("../src/app/api/runs/[id]/route");
    const replay = await import("../src/app/api/runs/[id]/replay/route");
    const step = await import("../src/app/api/runs/[id]/steps/[n]/route");
    const verify = await import("../src/app/api/runs/[id]/verify/route");
    const diff = await import("../src/app/api/diff/route");
    const ledger = await import("../src/app/api/ledger/route");

    const created = await runs.POST(post({ workflow: "demo-tracker", executor: "mock" }));
    expect(created.status).toBe(201);
    const { runId, outcome } = (await created.json()) as { runId: string; outcome: string };
    expect(outcome).toBe("failed");

    const list = (await (await runs.GET()).json()) as { runs: unknown[] };
    expect(list.runs).toHaveLength(1);
    const detail = (await (await one.GET(new Request("http://x"), ctx({ id: runId }))).json()) as { snapshots: unknown[] };
    expect(detail.snapshots).toHaveLength(3);
    expect((await step.GET(new Request("http://x"), ctx({ id: runId, n: "1" }))).status).toBe(200);
    expect((await step.GET(new Request("http://x"), ctx({ id: runId, n: "9" }))).status).toBe(404);

    const guarded = await replay.POST(post({ fromStep: 0 }), ctx({ id: runId }));
    expect(guarded.status).toBe(409);
    expect(((await guarded.json()) as { details: { guarded: string[] } }).details.guarded).toEqual(["0:create", "1:label"]);

    const ok = await replay.POST(post({ fromStep: 0, compensate: true, set: ["inputs.finalState=closed"] }), ctx({ id: runId }));
    expect(ok.status).toBe(201);
    const okBody = (await ok.json()) as { runId: string; outcome: string };
    expect(okBody.outcome).toBe("ok");

    const d = await diff.GET(new Request(`http://x/api/diff?a=${runId}&b=${okBody.runId}`));
    expect(d.status).toBe(200);
    expect(((await (await ledger.GET()).json()) as { ledger: { created: number; deleted: number } }).ledger).toMatchObject({ created: 2, deleted: 1 });
    expect(((await (await verify.POST(new Request("http://x"), ctx({ id: runId }))).json()) as { ok: boolean }).ok).toBe(true);
  });

  it("rejects bad bodies (400), path traversal (400) and unknown runs (404)", async () => {
    const runs = await import("../src/app/api/runs/route");
    const one = await import("../src/app/api/runs/[id]/route");
    const replay = await import("../src/app/api/runs/[id]/replay/route");
    expect((await runs.POST(post({ workflow: "../../etc/passwd" }))).status).toBe(400);
    expect((await runs.POST(post({ nope: 1 }))).status).toBe(400);
    expect((await runs.POST(new Request("http://x", { method: "POST", body: "{not json" }))).status).toBe(400);
    expect((await one.GET(new Request("http://x"), ctx({ id: "../../etc" }))).status).toBe(400);
    expect((await one.GET(new Request("http://x"), ctx({ id: "r_missing" }))).status).toBe(404);
    expect((await replay.POST(post({ fromStep: -1 }), ctx({ id: "r_missing" }))).status).toBe(400);
  });

  it("refuses real GitHub execution until credentials, auth, and durable storage are configured", async () => {
    const names = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO", "GITHUB_ALLOWED_EMAIL", "NEON_AUTH_BASE_URL", "NEON_AUTH_COOKIE_SECRET", "DATABASE_URL"];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    names.forEach((name) => delete process.env[name]);
    try {
      const runs = await import("../src/app/api/runs/route");
      const result = await runs.POST(post({ workflow: "github-issue", executor: "github" }));
      expect(result.status).toBe(503);
      expect((await result.json()).error).toContain("Live GitHub execution is not configured");
      const implicit = await runs.POST(post({ workflow: "github-issue" }));
      expect(implicit.status).toBe(503);
      expect((await implicit.json()).error).toContain("Live GitHub execution is not configured");
    } finally {
      names.forEach((name) => {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      });
    }
  });
});
