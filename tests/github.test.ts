import { describe, expect, it, vi } from "vitest";
import { GitHubExecutor } from "../src/executors/github";

function fakeFetch(payload: unknown, status = 201) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }),
  );
  return fetcher as typeof fetch;
}

const config = { token: "unit-test-token", owner: "ridhimakulashriz", repo: "switchtm" };

describe("GitHubExecutor", () => {
  it("creates a real issue using the configured repository and returns a compact snapshot output", async () => {
    const fetcher = fakeFetch({ number: 27, id: 99, title: "Test issue", state: "open", html_url: "https://github.com/ridhimakulashriz/switchtm/issues/27", labels: [] });
    const executor = new GitHubExecutor({ ...config, fetcher });
    const result = await executor.exec("github.issue.create", {
      owner: config.owner,
      repo: config.repo,
      body: { title: "Test issue" },
    }, { dryRun: false });

    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/ridhimakulashriz/switchtm/issues");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer unit-test-token");
    expect(JSON.parse(String(init?.body))).toEqual({ title: "Test issue" });
    expect(result.ok && result.output).toMatchObject({ number: 27, title: "Test issue", state: "open" });
  });

  it("adds labels to an issue and patches its state", async () => {
    const fetcher = fakeFetch([{ name: "bug" }], 200);
    const executor = new GitHubExecutor({ ...config, fetcher });
    const labels = await executor.exec("github.issue.labels.create", {
      owner: config.owner, repo: config.repo, issue_number: 7, body: { labels: ["bug"] },
    }, { dryRun: false });
    expect(labels.ok && labels.output).toEqual({ number: 7, labels: ["bug"] });
    expect(String(vi.mocked(fetcher).mock.calls[0][0])).toContain("/issues/7/labels");

    const patchFetch = fakeFetch({ number: 7, title: "Issue", state: "closed", labels: [] }, 200);
    const update = await new GitHubExecutor({ ...config, fetcher: patchFetch }).exec("github.issue.update", {
      owner: config.owner, repo: config.repo, issue_number: 7, body: { state: "closed" },
    }, { dryRun: false });
    expect(update.ok && update.output).toMatchObject({ number: 7, state: "closed" });
    expect(vi.mocked(patchFetch).mock.calls[0][1]?.method).toBe("PATCH");
  });

  it("rejects a different repository before making a network request", async () => {
    const fetcher = fakeFetch({});
    const result = await new GitHubExecutor({ ...config, fetcher }).exec("github.issue.create", {
      owner: "someone-else", repo: "other-repo", body: { title: "No" },
    }, { dryRun: false });
    expect(result.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates issue titles and supports a side-effect-free dry run", async () => {
    const fetcher = fakeFetch({ number: 1 });
    const executor = new GitHubExecutor({ ...config, fetcher });
    const invalid = await executor.exec("github.issue.create", {
      owner: config.owner, repo: config.repo, body: { title: "  " },
    }, { dryRun: false });
    expect(invalid.ok).toBe(false);

    const preview = await executor.exec("github.issue.create", {
      owner: config.owner, repo: config.repo, body: { title: "Preview" },
    }, { dryRun: true });
    expect(preview.ok && preview.output).toMatchObject({ dryRun: true, executor: "github", repository: "ridhimakulashriz/switchtm" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
