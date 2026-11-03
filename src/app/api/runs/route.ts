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
    if (resolveRunExecutor(body) === "github") {
      const denied = await authorizeGitHubExecution();
      if (denied) return denied;
    }
    return Response.json(await startRun(body), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
