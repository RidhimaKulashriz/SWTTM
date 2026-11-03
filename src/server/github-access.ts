import { githubAuthConfigured, githubIntegrationConfigured, githubReady } from "@/executors/github";

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function authorizeGitHubUser(): Promise<Response | null> {
  if (!githubIntegrationConfigured()) return null;
  if (!githubAuthConfigured()) {
    return jsonError("Live GitHub data is private, but Neon Auth or GITHUB_ALLOWED_EMAIL is not configured.", 503);
  }
  try {
    const { getAuth } = await import("@/lib/auth/server");
    const { data, error } = await getAuth().getSession();
    if (error) return jsonError("Could not verify the sign-in session.", 503);
    if (!data?.user) return jsonError("Sign in before accessing live GitHub runs.", 401);
    const allowed = process.env.GITHUB_ALLOWED_EMAIL!.trim().toLowerCase();
    if (data.user.email?.trim().toLowerCase() !== allowed) {
      return jsonError("This account is not authorized to access the configured GitHub repository.", 403);
    }
    return null;
  } catch {
    return jsonError("Neon Auth is unavailable; live GitHub access is blocked.", 503);
  }
}

export async function authorizeGitHubExecution(): Promise<Response | null> {
  if (!githubReady()) {
    return jsonError(
      "Live GitHub execution is not configured. Set GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_ALLOWED_EMAIL, NEON_AUTH_BASE_URL, NEON_AUTH_COOKIE_SECRET, and DATABASE_URL in the deployment environment.",
      503,
    );
  }
  return authorizeGitHubUser();
}
