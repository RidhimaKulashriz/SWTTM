import { resolveAccess } from "@/server/access";
import { ReplayBody, errorResponse, readJson, startReplay } from "@/server/service";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccess(req);
    if (access instanceof Response) return access;
    const { id } = await ctx.params;
    const body = ReplayBody.parse(await readJson(req));
    return Response.json(await startReplay(id, body, { access }), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
