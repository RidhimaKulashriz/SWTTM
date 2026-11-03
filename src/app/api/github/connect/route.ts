import { AccessError, verifyConnection } from "@/server/access";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function fail(error: string, status: number, code: string) {
  return Response.json({ error, code }, { status, headers: NO_STORE });
}

/** Strip things people commonly paste along with a token or repository. */
function cleanToken(raw: string): string {
  return raw.trim().replace(/^bearer\s+/i, "").replace(/^["']|["']$/g, "");
}
function cleanRepo(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .split("/")
    .slice(0, 2)
    .join("/");
}

/**
 * Verify the visitor's own token + repository against the real GitHub API. Nothing is stored; the token stays in their browser.
 * Credentials are accepted from the JSON body (preferred) or from the x-gh-token / x-gh-repo headers.
 */
export async function POST(req: Request) {
  let token = req.headers.get("x-gh-token") ?? "";
  let repo = req.headers.get("x-gh-repo") ?? "";
  if (!token || !repo) {
    const body = (await req.json().catch(() => null)) as { token?: unknown; repo?: unknown } | null;
    if (!token && typeof body?.token === "string") token = body.token;
    if (!repo && typeof body?.repo === "string") repo = body.repo;
  }
  token = cleanToken(token);
  repo = cleanRepo(repo);
  if (!token && !repo) return fail("Paste your GitHub token and the repository (owner/name), then press Connect.", 400, "connect_required");
  if (!token) return fail("The GitHub token is missing. Paste your personal access token.", 400, "token_missing");
  if (!repo) return fail("The repository is missing. Enter it as owner/name, for example your-name/your-repo.", 400, "repo_missing");
  try {
    const v = await verifyConnection(token, repo);
    return Response.json({ connected: true, ...v.info }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AccessError) return fail(e.message, e.status, "connection_failed");
    return fail("Could not verify the GitHub connection. Please try again.", 502, "connection_failed");
  }
}
