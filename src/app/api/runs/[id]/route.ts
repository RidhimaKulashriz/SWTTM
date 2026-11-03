import { resolveAccess } from "@/server/access";
import { errorResponse, getRun } from "@/server/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccess(req);
    if (access instanceof Response) return access;
    const { id } = await ctx.params;
    return Response.json(await getRun(id, access), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
