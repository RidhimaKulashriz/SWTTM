import { requireLive, resolveAccess } from "@/server/access";
import { RunBody, errorResponse, listRuns, readJson, resolveRunExecutor, startRun, workflows } from "@/server/service";

export const dynamic = "force-dynamic";

export async function GET(req?: Request) {
  try {
    const access = await resolveAccess(req);
    if (access instanceof Response) return access;
    return Response.json({ runs: await listRuns(access), workflows: workflows() }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const access = await resolveAccess(req);
    if (access instanceof Response) return access;
    const body = RunBody.parse(await readJson(req));
    // Real GitHub workflows always need a connected account. (The offline simulator is only for the CLI and tests.)
    if (resolveRunExecutor(body) === "github") {
      const denied = requireLive(access);
      if (denied) return denied;
    }
    return Response.json(await startRun(body, { access }), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
