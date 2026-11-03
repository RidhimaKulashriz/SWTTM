import { resolveAccess } from "@/server/access";
import { errorResponse, getStep } from "@/server/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string; n: string }> }) {
  try {
    const access = await resolveAccess(req);
    if (access instanceof Response) return access;
    const { id, n } = await ctx.params;
    return Response.json(await getStep(id, n, access));
  } catch (e) {
    return errorResponse(e);
  }
}
