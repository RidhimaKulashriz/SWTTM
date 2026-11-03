import type { ExecResult, Executor, StepError } from "../core/types";

export type GitHubConfig = {
  token?: string;
  owner?: string;
  repo?: string;
  fetcher?: typeof fetch;
};

type IssueInput = {
  owner?: unknown;
  repo?: unknown;
  issue_number?: unknown;
  comment_id?: unknown;
  name?: unknown;
  body?: Record<string, unknown>;
};

type GitHubIssue = {
  id?: number;
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  updated_at?: string;
  labels?: Array<{ name?: string } | string>;
  body?: string;
};

export const GITHUB_API = "https://api.github.com";
export const GITHUB_TIMEOUT_MS = 15_000;

export function githubEnvironment() {
  return {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    allowedEmail: process.env.GITHUB_ALLOWED_EMAIL,
  };
}

export function githubCredentialsConfigured() {
  const { token, owner, repo } = githubEnvironment();
  return Boolean(token && owner && repo);
}

export function githubIntegrationConfigured() {
  const { token, owner, repo } = githubEnvironment();
  return Boolean(token || owner || repo);
}

export function githubAuthConfigured() {
  return Boolean(
    process.env.NEON_AUTH_BASE_URL &&
    process.env.NEON_AUTH_COOKIE_SECRET &&
    process.env.NEON_AUTH_COOKIE_SECRET.length >= 32 &&
    process.env.GITHUB_ALLOWED_EMAIL,
  );
}

export function githubReady() {
  return githubCredentialsConfigured() && githubAuthConfigured() && Boolean(process.env.DATABASE_URL);
}

export function issueOutput(issue: GitHubIssue) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.html_url,
    updated_at: issue.updated_at,
    labels: issue.labels?.map((x) => (typeof x === "string" ? x : x.name)).filter(Boolean),
  };
}

/** Plain-language explanation of a GitHub failure so the debugger shows something actionable. */
function explain(status: number, message: string, headers: Headers): StepError {
  const remaining = headers.get("x-ratelimit-remaining");
  const rateLimited = status === 429 || (status === 403 && remaining === "0");
  let suggestedAction: string | undefined;
  if (rateLimited) suggestedAction = "GitHub rate limit reached. Wait for the limit to reset, then replay from this step.";
  else if (status === 401) suggestedAction = "The token was rejected. Reconnect with a valid token.";
  else if (status === 403) suggestedAction = "The token lacks permission. It needs Issues: read & write on this repository.";
  else if (status === 404) suggestedAction = "Repository or issue not found, or the token cannot see it.";
  else if (status === 410) suggestedAction = "Issues are disabled for this repository.";
  else if (status === 422) suggestedAction = "GitHub rejected the input. Fix the value in the replay panel and replay from this step.";
  return {
    category: rateLimited ? "rate_limit" : status === 401 || status === 403 ? "github_auth" : status === 404 ? "not_found" : status === 422 ? "validation" : "github_api",
    message: `GitHub API ${status}: ${message}`,
    retryable: rateLimited || status >= 500,
    suggestedAction,
    raw: { status, rateLimitRemaining: remaining ?? undefined },
  };
}

export class GitHubExecutor implements Executor {
  name = "github" as const;
  mock = false;

  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly fetcher: typeof fetch;

  constructor(config: GitHubConfig = {}) {
    const env = githubEnvironment();
    this.token = config.token ?? env.token ?? "";
    this.owner = config.owner ?? env.owner ?? "";
    this.repo = config.repo ?? env.repo ?? "";
    this.fetcher = config.fetcher ?? fetch;
  }

  async exec(canonicalId: string, input: unknown, ctx: { dryRun: boolean }): Promise<ExecResult> {
    if (!this.token || !this.owner || !this.repo) {
      return {
        ok: false,
        error: {
          category: "configuration",
          message: "Connect a GitHub token and repository before running live workflows.",
          retryable: false,
        },
      };
    }
    const args = (input ?? {}) as IssueInput;
    if (String(args.owner).toLowerCase() !== this.owner.toLowerCase() || String(args.repo).toLowerCase() !== this.repo.toLowerCase()) {
      return {
        ok: false,
        error: {
          category: "authorization",
          message: `The workflow targets ${String(args.owner)}/${String(args.repo)}, but this session is connected to ${this.owner}/${this.repo}. Reconnect to that repository to run or replay it.`,
          retryable: false,
        },
      };
    }

    const base = `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
    const invalid = (message: string): ExecResult => ({ ok: false, error: { category: "validation", message, retryable: false } });
    let method: "POST" | "PATCH" | "DELETE";
    let path: string;
    let requestBody: Record<string, unknown> | undefined;

    if (canonicalId === "github.issue.create") {
      const title = args.body?.title;
      if (typeof title !== "string" || !title.trim()) return invalid("A non-empty issue title is required.");
      if (title.length > 256) return invalid("Issue titles are limited to 256 characters.");
      method = "POST";
      path = `${base}/issues`;
      requestBody = { title: title.trim(), ...(typeof args.body?.body === "string" ? { body: args.body.body } : {}) };
    } else if (canonicalId === "github.issue.comment.delete") {
      const commentId = Number(args.comment_id);
      if (!Number.isSafeInteger(commentId) || commentId < 1) return invalid("A valid comment id is required.");
      method = "DELETE";
      path = `${base}/issues/comments/${commentId}`;
    } else {
      const issueNumber = Number(args.issue_number);
      if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) return invalid("A valid GitHub issue number is required.");
      if (canonicalId === "github.issue.labels.create") {
        const labels = args.body?.labels;
        if (!Array.isArray(labels) || labels.length === 0 || labels.some((x) => typeof x !== "string" || !x.trim())) {
          return invalid("At least one valid label is required.");
        }
        method = "POST";
        path = `${base}/issues/${issueNumber}/labels`;
        requestBody = { labels };
      } else if (canonicalId === "github.issue.labels.remove") {
        const name = args.name;
        if (typeof name !== "string" || !name.trim()) return invalid("A label name is required.");
        method = "DELETE";
        path = `${base}/issues/${issueNumber}/labels/${encodeURIComponent(name)}`;
      } else if (canonicalId === "github.issue.comment.create") {
        const text = args.body?.body;
        if (typeof text !== "string" || !text.trim()) return invalid("A non-empty comment is required.");
        method = "POST";
        path = `${base}/issues/${issueNumber}/comments`;
        requestBody = { body: text };
      } else if (canonicalId === "github.issue.update") {
        const state = args.body?.state;
        if (state !== "open" && state !== "closed") return invalid("GitHub issue state must be 'open' or 'closed'.");
        method = "PATCH";
        path = `${base}/issues/${issueNumber}`;
        requestBody = { state };
      } else {
        return { ok: false, error: { category: "unsupported_operation", message: `Unsupported GitHub operation: ${canonicalId}`, retryable: false } };
      }
    }

    if (ctx.dryRun) {
      return {
        ok: true,
        output: { dryRun: true, executor: "github", method, path, repository: `${this.owner}/${this.repo}`, request: requestBody ?? null },
      };
    }

    let response: Response;
    try {
      response = await this.fetcher(`${GITHUB_API}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "swy-tm-debugger",
          ...(requestBody ? { "Content-Type": "application/json" } : {}),
        },
        body: requestBody ? JSON.stringify(requestBody) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
      return {
        ok: false,
        error: {
          category: "network",
          message: timedOut ? "GitHub did not answer within 15 seconds." : "Could not reach the GitHub API.",
          retryable: true,
          suggestedAction: "Check connectivity, then replay from this step.",
        },
      };
    }

    const payload = (await response.json().catch(() => ({}))) as GitHubIssue | { message?: string } | Array<{ name?: string }>;
    if (!response.ok) {
      const message = payload && !Array.isArray(payload) && "message" in payload && typeof payload.message === "string"
        ? payload.message.slice(0, 400)
        : "GitHub API request failed.";
      return { ok: false, error: explain(response.status, message, response.headers) };
    }

    if (canonicalId === "github.issue.labels.create" || canonicalId === "github.issue.labels.remove") {
      const labels = Array.isArray(payload) ? payload.map((x) => x.name).filter(Boolean) : [];
      return { ok: true, output: { number: Number(args.issue_number), labels } };
    }
    if (canonicalId === "github.issue.comment.create") {
      const c = payload as { id?: number; html_url?: string; body?: string };
      return { ok: true, output: { id: c.id, number: Number(args.issue_number), url: c.html_url, body: c.body } };
    }
    if (canonicalId === "github.issue.comment.delete") {
      return { ok: true, output: { id: Number(args.comment_id), deleted: true } };
    }
    return { ok: true, output: issueOutput(payload as GitHubIssue) };
  }
}
