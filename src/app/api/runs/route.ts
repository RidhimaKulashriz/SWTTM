import { RunBody, errorResponse, listRuns, readJson, resolveRunExecutor, startRun, workflows } from "@/server/service";
import { authorizeGitHubExecution, authorizeGitHubUser } from "@/server/github-access";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const denied = await authorizeGitHubUser();
    if (denied) return denied;
    return Response.json({ runs: await listRuns(), workflows: workflows() });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const body = RunBody.parse(await readJson(req));
    const executor = resolveRunExecutor(body);
    if (executor === "github") {
      const denied = await authorizeGitHubExecution();
      if (denied) return denied;
      return Response.json(await startRun(body), { status: 201 });
    }
    // The mock executor touches no real system, so anyone may use it. Only signed-in owners get their mock runs
    // saved to the shared history; everyone else receives the full run in the response (session-only).
    const denied = await authorizeGitHubUser();
    if (denied && executor !== "mock") return denied;
    return Response.json(await startRun(body, { persist: !denied }), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
