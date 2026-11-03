import type { ExecResult, Executor } from "../core/types";

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
};

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

function issueOutput(issue: GitHubIssue) {
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
          message: "Live GitHub execution is not configured. Set GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO on the server.",
          retryable: false,
        },
      };
    }
    const args = (input ?? {}) as IssueInput;
    if (args.owner !== this.owner || args.repo !== this.repo) {
      return {
        ok: false,
        error: {
          category: "authorization",
          message: "The workflow target does not match the server-configured GitHub repository.",
          retryable: false,
        },
      };
    }

    let method: "POST" | "PATCH";
    let path: string;
    let requestBody: Record<string, unknown>;
    if (canonicalId === "github.issue.create") {
      const title = args.body?.title;
      if (typeof title !== "string" || !title.trim()) {
        return { ok: false, error: { category: "validation", message: "A non-empty issue title is required.", retryable: false } };
      }
      method = "POST";
      path = `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues`;
      requestBody = args.body ?? {};
    } else {
      const issueNumber = Number(args.issue_number);
      if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
        return { ok: false, error: { category: "validation", message: "A valid GitHub issue number is required.", retryable: false } };
      }
      if (canonicalId === "github.issue.labels.create") {
        const labels = args.body?.labels;
        if (!Array.isArray(labels) || labels.length === 0 || labels.some((x) => typeof x !== "string" || !x.trim())) {
          return { ok: false, error: { category: "validation", message: "At least one valid label is required.", retryable: false } };
        }
        method = "POST";
        path = `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues/${issueNumber}/labels`;
        requestBody = { labels };
      } else if (canonicalId === "github.issue.update") {
        const state = args.body?.state;
        if (state !== "open" && state !== "closed") {
          return { ok: false, error: { category: "validation", message: "GitHub issue state must be 'open' or 'closed'.", retryable: false } };
        }
        method = "PATCH";
        path = `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues/${issueNumber}`;
        requestBody = { state };
      } else {
        return { ok: false, error: { category: "unsupported_operation", message: `Unsupported GitHub operation: ${canonicalId}`, retryable: false } };
      }
    }

    if (ctx.dryRun) {
      return {
        ok: true,
        output: { dryRun: true, executor: "github", method, path, repository: `${this.owner}/${this.repo}`, request: requestBody },
      };
    }

    let response: Response;
    try {
      response = await this.fetcher(`https://api.github.com${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        cache: "no-store",
      });
    } catch {
      return { ok: false, error: { category: "network", message: "Could not reach the GitHub API.", retryable: true } };
    }

    const payload = (await response.json().catch(() => ({}))) as GitHubIssue | { message?: string } | Array<{ name?: string }>;
    if (!response.ok) {
      const message = payload && !Array.isArray(payload) && "message" in payload && typeof payload.message === "string"
        ? payload.message.slice(0, 400)
        : "GitHub API request failed.";
      return {
        ok: false,
        error: {
          category: response.status === 401 || response.status === 403 ? "github_auth" : response.status === 404 ? "not_found" : "github_api",
          message: `GitHub API ${response.status}: ${message}`,
          retryable: response.status === 429 || response.status >= 500,
          raw: { status: response.status },
        },
      };
    }

    if (canonicalId === "github.issue.labels.create" && Array.isArray(payload)) {
      return { ok: true, output: { number: Number(args.issue_number), labels: payload.map((x) => x.name).filter(Boolean) } };
    }
    return { ok: true, output: issueOutput(payload as GitHubIssue) };
  }
}
