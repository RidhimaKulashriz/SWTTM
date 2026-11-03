import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A tiny in-memory GitHub: just enough of the REST API to exercise real-execution code paths over HTTP shapes. */
function fakeGitHub() {
  const users: Record<string, { id: number; login: string }> = {
    tokenAAAAAAAAAAAAAAAAAAAA: { id: 1, login: "alice" },
    tokenBBBBBBBBBBBBBBBBBBBB: { id: 2, login: "bob" },
  };
  const issues = new Map<number, { number: number; id: number; title: string; state: string; labels: string[]; comments: { id: number; body: string }[] }>();
  let next = 1;
  let commentId = 500;
  const calls: string[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" } });
  const view = (i: { number: number; id: number; title: string; state: string; labels: string[]; comments: unknown[] }) => ({
    number: i.number, id: i.id, title: i.title, state: i.state, comments: i.comments.length,
    html_url: `https://github.com/alice/demo/issues/${i.number}`, labels: i.labels.map((name) => ({ name })),
  });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const token = String(new Headers(init?.headers).get("authorization")).replace("Bearer ", "");
    const user = users[token];
    calls.push(`${method} ${url.pathname}`);
    if (!user) return json({ message: "Bad credentials" }, 401);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const p = url.pathname;
    if (p === "/user") return json({ ...user, name: null, avatar_url: "" });
    if (p === "/repos/alice/demo") {
      return user.login === "alice"
        ? json({ full_name: "alice/demo", html_url: "https://github.com/alice/demo", private: true, has_issues: true, open_issues_count: 0, default_branch: "main", permissions: { push: true } })
        : json({ message: "Not Found" }, 404);
    }
    if (user.login !== "alice") return json({ message: "Not Found" }, 404);
    let m: RegExpExecArray | null;
    if (p === "/repos/alice/demo/issues" && method === "POST") {
      const issue = { number: next, id: 1000 + next, title: body.title, state: "open", labels: [] as string[], comments: [] as { id: number; body: string }[] };
      issues.set(next++, issue);
      return json(view(issue), 201);
    }
    if ((m = /^\/repos\/alice\/demo\/issues\/(\d+)\/labels$/.exec(p)) && method === "POST") {
      const i = issues.get(Number(m[1]));
      if (!i) return json({ message: "Not Found" }, 404);
      for (const l of body.labels) if (!i.labels.includes(l)) i.labels.push(l);
      return json(i.labels.map((name) => ({ name })));
    }
    if ((m = /^\/repos\/alice\/demo\/issues\/(\d+)\/labels\/(.+)$/.exec(p)) && method === "DELETE") {
      const i = issues.get(Number(m[1]))!;
      i.labels = i.labels.filter((l) => l !== decodeURIComponent(m![2]));
      return json(i.labels.map((name) => ({ name })));
    }
    if ((m = /^\/repos\/alice\/demo\/issues\/(\d+)\/comments$/.exec(p))) {
      const i = issues.get(Number(m[1]));
      if (!i) return json({ message: "Not Found" }, 404);
      if (method === "GET") return json(i.comments);
      const c = { id: commentId++, body: body.body };
      i.comments.push(c);
      return json({ ...c, html_url: `https://github.com/alice/demo/issues/${i.number}#c${c.id}` }, 201);
    }
    if ((m = /^\/repos\/alice\/demo\/issues\/comments\/(\d+)$/.exec(p)) && method === "DELETE") {
      for (const i of issues.values()) i.comments = i.comments.filter((c) => c.id !== Number(m![1]));
      return new Response(null, { status: 204 });
    }
    if ((m = /^\/repos\/alice\/demo\/issues\/(\d+)$/.exec(p))) {
      const i = issues.get(Number(m[1]));
      if (!i) return json({ message: "Not Found" }, 404);
      if (method === "PATCH") i.state = body.state;
      return json(view(i));
    }
    return json({ message: "Not Found" }, 404);
  });
  return { fetcher: fetcher as unknown as typeof fetch, issues, calls };
}

const A = { "x-gh-token": "tokenAAAAAAAAAAAAAAAAAAAA", "x-gh-repo": "alice/demo", "content-type": "application/json" };
const B = { "x-gh-token": "tokenBBBBBBBBBBBBBBBBBBBB", "x-gh-repo": "alice/demo", "content-type": "application/json" };
const req = (body: unknown, headers: Record<string, string>) => new Request("http://x/api", { method: "POST", body: JSON.stringify(body), headers });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let gh: ReturnType<typeof fakeGitHub>;
beforeEach(() => {
  gh = fakeGitHub();
  vi.stubGlobal("fetch", gh.fetcher);
});
afterEach(() => vi.unstubAllGlobals());

describe("real GitHub debugging, one account at a time", () => {
  it("verifies a token and repository, and refuses accounts without access", async () => {
    const connect = await import("../src/app/api/github/connect/route");
    const ok = await connect.POST(req({}, A));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ connected: true, login: "alice", repository: "alice/demo", private: true });
    expect((await connect.POST(req({}, B))).status).toBe(404);
    expect((await connect.POST(req({}, { ...A, "x-gh-token": "tokenZZZZZZZZZZZZZZZZZZZZ" }))).status).toBe(401);
    expect((await connect.POST(req({}, { ...A, "x-gh-repo": "../etc" }))).status).toBe(400);
  });

  it("run fails on the last step, replay re-uses recorded steps (no duplicate issue), live check finds it in sync", async () => {
    const runs = await import("../src/app/api/runs/route");
    const replay = await import("../src/app/api/runs/[id]/replay/route");
    const reconcile = await import("../src/app/api/runs/[id]/reconcile/route");
    const verify = await import("../src/app/api/runs/[id]/verify/route");

    const created = await runs.POST(req({ workflow: "github-triage", set: ['inputs.owner="alice"', 'inputs.repo="demo"', 'inputs.title="Checkout bug"', 'inputs.finalState="pending"'] }, A));
    expect(created.status).toBe(201);
    const run = (await created.json()) as { runId: string; outcome: string; manifest: { executor: string; mock: boolean; failedStep: number }; snapshots: { status: string; mock: boolean }[] };
    expect(run.outcome).toBe("failed");
    expect(run.manifest).toMatchObject({ executor: "github", mock: false, failedStep: 3 });
    expect(run.snapshots.map((s) => s.status)).toEqual(["ok", "ok", "ok", "error"]);
    expect(run.snapshots.every((s) => s.mock === false)).toBe(true);
    expect(gh.issues.size).toBe(1);
    const seed = { manifest: run.manifest, snapshots: run.snapshots };

    // no token => no replay of a real run, even with the data
    expect((await replay.POST(req({ fromStep: 3, seed }, { "content-type": "application/json" }), ctx(run.runId))).status).toBe(401);

    const before = gh.calls.length;
    const fixed = await replay.POST(req({ fromStep: 3, set: ['inputs.finalState="closed"'], seed }, A), ctx(run.runId));
    expect(fixed.status).toBe(201);
    const r2 = (await fixed.json()) as { outcome: string; injected: number; executorCalls: number; snapshots: { status: string }[]; manifest: unknown };
    expect(r2).toMatchObject({ outcome: "ok", injected: 3, executorCalls: 1 });
    expect(r2.snapshots.map((s) => s.status)).toEqual(["injected", "injected", "injected", "ok"]);
    expect(gh.issues.size).toBe(1); // still ONE issue: earlier steps were injected, not re-executed
    expect(gh.calls.slice(before).filter((c) => c.startsWith("PATCH") || c.startsWith("POST"))).toHaveLength(1);
    expect(gh.issues.get(1)).toMatchObject({ state: "closed", labels: ["bug"] });

    const live = await reconcile.POST(req({ seed: { manifest: r2.manifest, snapshots: r2.snapshots } }, A), ctx((r2 as unknown as { manifest: { runId: string } }).manifest.runId));
    const report = (await live.json()) as { summary: { inSync: number; drift: number }; issues: { number: number }[] };
    expect(live.status).toBe(200);
    expect(report.summary).toMatchObject({ inSync: 1, drift: 0 });

    // someone edits the issue directly on GitHub -> drift is detected
    gh.issues.get(1)!.state = "open";
    const drift = await reconcile.POST(req({ seed: { manifest: r2.manifest, snapshots: r2.snapshots } }, A), ctx((r2 as unknown as { manifest: { runId: string } }).manifest.runId));
    const d = (await drift.json()) as { summary: { drift: number }; issues: { notes: string[] }[] };
    expect(d.summary.drift).toBe(1);
    expect(d.issues[0].notes[0]).toContain("open");

    // hash chain: tampering with a recorded snapshot is rejected
    const tampered = structuredClone(seed);
    (tampered.snapshots[0] as unknown as { output: { number: number } }).output.number = 99;
    expect((await verify.POST(req({ seed }, A), ctx(run.runId))).status).toBe(200);
    expect(await (await verify.POST(req({ seed }, A), ctx(run.runId))).json()).toMatchObject({ ok: true, checked: 4 });
    expect((await verify.POST(req({ seed: tampered }, A), ctx(run.runId))).status).toBe(422);
    expect((await replay.POST(req({ fromStep: 3, seed: tampered }, A), ctx(run.runId))).status).toBe(422);
  });

  it("compensate undoes every real effect in reverse order before re-running", async () => {
    const runs = await import("../src/app/api/runs/route");
    const replay = await import("../src/app/api/runs/[id]/replay/route");
    const created = await runs.POST(req({ workflow: "github-triage", set: ['inputs.owner="alice"', 'inputs.repo="demo"', 'inputs.finalState="pending"'] }, A));
    const run = (await created.json()) as { runId: string; manifest: unknown; snapshots: unknown[] };
    const seed = { manifest: run.manifest, snapshots: run.snapshots };
    const guard = await replay.POST(req({ fromStep: 0, seed }, A), ctx(run.runId));
    expect(guard.status).toBe(409);
    const ok = await replay.POST(req({ fromStep: 0, compensate: true, set: ['inputs.finalState="closed"'], seed }, A), ctx(run.runId));
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { outcome: string; compensated: string[] };
    expect(body.outcome).toBe("ok");
    expect(body.compensated).toEqual(["comment", "label", "create"]);
    expect(gh.issues.get(1)).toMatchObject({ state: "closed", labels: [], comments: [] }); // first issue was undone
    expect(gh.issues.get(2)).toMatchObject({ state: "closed", labels: ["bug"] });
  });

  it("a different account cannot replay or read someone else's real run", async () => {
    const runs = await import("../src/app/api/runs/route");
    const replay = await import("../src/app/api/runs/[id]/replay/route");
    const one = await import("../src/app/api/runs/[id]/route");
    const created = await runs.POST(req({ workflow: "github-issue", set: ['inputs.owner="alice"', 'inputs.repo="demo"'] }, A));
    const run = (await created.json()) as { runId: string; manifest: unknown; snapshots: unknown[] };
    // Bob cannot even connect to alice/demo with his token, and cannot fetch her run by id
    expect((await replay.POST(req({ fromStep: 0, allowDuplicate: true, seed: { manifest: run.manifest, snapshots: run.snapshots } }, B), ctx(run.runId))).status).toBe(404);
    expect((await one.GET(new Request("http://x", { headers: B }), ctx(run.runId))).status).toBe(404);
    expect((await one.GET(new Request("http://x", { headers: A }), ctx(run.runId))).status).toBe(404); // not stored without a database: it stays in the owner's browser
  });
});
