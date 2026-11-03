import { createHash } from "node:crypto";
import { GITHUB_API, GITHUB_TIMEOUT_MS, githubReady } from "../executors/github";
import { authorizeGitHubUser } from "./github-access";

/** A GitHub account + repository the visitor proved they can use. The token only lives for the length of a request. */
export type Connection = {
  token: string;
  owner: string;
  repo: string;
  login: string;
  userId: number;
  ownerKey: string;
};

export type ConnectionInfo = {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  repository: string;
  repositoryUrl: string;
  private: boolean;
  defaultBranch: string | null;
  openIssues: number;
  canWriteIssues: boolean | null;
  rateLimitRemaining: number | null;
};

export type Access =
  | { kind: "connection"; ownerKey: string; connection: Connection }
  | { kind: "owner"; ownerKey: "server" }
  | { kind: "anonymous"; ownerKey: "anonymous" };

export class AccessError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const REPO_RE = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;
const TTL_MS = 60_000;

type Verified = { info: ConnectionInfo; userId: number; owner: string; repo: string; at: number };
const g = globalThis as unknown as { __swytmConn?: Map<string, Verified> };
const cache = (g.__swytmConn ??= new Map());

export function parseRepository(slug: string): { owner: string; repo: string } {
  const m = REPO_RE.exec(slug.trim());
  if (!m || m[1] === "." || m[1] === ".." || m[2] === "." || m[2] === "..") {
    throw new AccessError("Repository must look like owner/name, for example octocat/hello-world.", 400);
  }
  return { owner: m[1], repo: m[2] };
}

async function gh(path: string, token: string, fetcher: typeof fetch): Promise<Response> {
  try {
    return await fetcher(`${GITHUB_API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "swy-tm-debugger",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch {
    throw new AccessError("Could not reach GitHub. Check your connection and try again.", 502);
  }
}

/** Check the token and repository against the real GitHub API. */
export async function verifyConnection(token: string, slug: string, fetcher: typeof fetch = fetch): Promise<{ info: ConnectionInfo; userId: number; owner: string; repo: string }> {
  if (!TOKEN_RE.test(token)) throw new AccessError("That does not look like a GitHub token. Paste a personal access token (it starts with ghp_ or github_pat_).", 400);
  const { owner, repo } = parseRepository(slug);
  const key = createHash("sha256").update(`${token}\n${owner}/${repo}`.toLowerCase()).digest("hex");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;

  const userRes = await gh("/user", token, fetcher);
  if (userRes.status === 401) throw new AccessError("GitHub rejected this token. It may be expired or revoked.", 401);
  if (!userRes.ok) throw new AccessError(`GitHub could not verify this token (HTTP ${userRes.status}).`, 502);
  const user = (await userRes.json().catch(() => ({}))) as { login?: string; id?: number; name?: string | null; avatar_url?: string };
  if (!user.login || typeof user.id !== "number") throw new AccessError("GitHub returned an unexpected account response.", 502);

  const repoRes = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token, fetcher);
  if (repoRes.status === 404) throw new AccessError(`${owner}/${repo} was not found, or this token cannot see it. For a fine-grained token, add the repository under "Repository access".`, 404);
  if (repoRes.status === 403) throw new AccessError(`This token is not allowed to read ${owner}/${repo}.`, 403);
  if (!repoRes.ok) throw new AccessError(`GitHub could not load ${owner}/${repo} (HTTP ${repoRes.status}).`, 502);
  const r = (await repoRes.json().catch(() => ({}))) as {
    full_name?: string;
    html_url?: string;
    private?: boolean;
    has_issues?: boolean;
    open_issues_count?: number;
    default_branch?: string;
    archived?: boolean;
    permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean };
  };
  if (r.has_issues === false) throw new AccessError(`Issues are turned off for ${owner}/${repo}. Enable them under Settings → Features.`, 422);
  if (r.archived) throw new AccessError(`${owner}/${repo} is archived and read-only.`, 422);
  const p = r.permissions;
  const canWrite = p ? Boolean(p.admin || p.maintain || p.push || p.triage) : null;
  if (canWrite === false) throw new AccessError(`This token can only read ${owner}/${repo}. Grant it Issues: read & write.`, 403);

  const verified = {
    owner: owner,
    repo: repo,
    userId: user.id,
    at: Date.now(),
    info: {
      login: user.login,
      name: user.name ?? null,
      avatarUrl: user.avatar_url ?? null,
      repository: r.full_name ?? `${owner}/${repo}`,
      repositoryUrl: r.html_url ?? `https://github.com/${owner}/${repo}`,
      private: Boolean(r.private),
      defaultBranch: r.default_branch ?? null,
      openIssues: r.open_issues_count ?? 0,
      canWriteIssues: canWrite,
      rateLimitRemaining: Number(repoRes.headers.get("x-ratelimit-remaining")) || null,
    } satisfies ConnectionInfo,
  };
  cache.set(key, verified);
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return verified;
}

function jsonError(error: string, status: number, code?: string) {
  return Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}

export const CONNECT_REQUIRED = "Connect your GitHub account and repository first.";

/**
 * Who is calling?
 *  - a visitor who sent their own token and repository (verified against GitHub) -> private, per-account history
 *  - the configured server owner (signed in)                                       -> shared owner history
 *  - nobody                                                                        -> anonymous
 */
export async function resolveAccess(req?: Request): Promise<Access | Response> {
  const token = req?.headers.get("x-gh-token")?.trim();
  const slug = req?.headers.get("x-gh-repo")?.trim();
  if (token || slug) {
    try {
      if (!token || !slug) throw new AccessError("Both a token and a repository are required.", 400);
      const v = await verifyConnection(token, slug);
      return {
        kind: "connection",
        ownerKey: `gh:${v.userId}`,
        connection: { token, owner: v.owner, repo: v.repo, login: v.info.login, userId: v.userId, ownerKey: `gh:${v.userId}` },
      };
    } catch (e) {
      if (e instanceof AccessError) return jsonError(e.message, e.status === 502 ? 502 : e.status, "connection_failed");
      return jsonError("Could not verify the GitHub connection.", 502, "connection_failed");
    }
  }
  const denied = await authorizeGitHubUser();
  if (denied) return denied;
  return process.env.GITHUB_TOKEN && githubReady() ? { kind: "owner", ownerKey: "server" } : { kind: "anonymous", ownerKey: "anonymous" };
}

export function requireLive(access: Access): Response | null {
  return access.kind === "anonymous" ? jsonError(CONNECT_REQUIRED, 401, "connect_required") : null;
}
