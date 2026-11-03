import { ReplayBody, errorResponse, readJson, startReplay } from "@/server/service";
import { authorizeGitHubUser } from "@/server/github-access";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const denied = await authorizeGitHubUser();
    if (denied) return denied;
    const { id } = await ctx.params;
    const body = ReplayBody.parse(await readJson(req));
    return Response.json(await startReplay(id, body), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
