import { VerifyBody, errorResponse, getVerify } from "@/server/service";
import { authorizeGitHubUser } from "@/server/github-access";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const raw = await req.json().catch(() => ({}));
    const body = VerifyBody.parse(raw ?? {});
    if (!body.seed) {
      const denied = await authorizeGitHubUser();
      if (denied) return denied;
    }
    return Response.json(await getVerify(id, body.seed));
  } catch (e) {
    return errorResponse(e);
  }
}
