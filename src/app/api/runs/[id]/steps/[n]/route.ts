import { errorResponse, getStep } from "@/server/service";
import { authorizeGitHubUser } from "@/server/github-access";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; n: string }> }) {
  try {
    const denied = await authorizeGitHubUser();
    if (denied) return denied;
    const { id, n } = await ctx.params;
    return Response.json(await getStep(id, n));
  } catch (e) {
    return errorResponse(e);
  }
}
