import { errorResponse, getRun } from "@/server/service";
import { authorizeGitHubUser } from "@/server/github-access";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const denied = await authorizeGitHubUser();
    if (denied) return denied;
    const { id } = await ctx.params;
    return Response.json(await getRun(id));
  } catch (e) {
    return errorResponse(e);
  }
}
