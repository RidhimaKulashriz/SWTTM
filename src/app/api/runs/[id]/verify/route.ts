import { resolveAccess } from "@/server/access";
import { VerifyBody, errorResponse, getVerify } from "@/server/service";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccess(req);
    if (access instanceof Response) return access;
    const { id } = await ctx.params;
    const raw = await req.json().catch(() => ({}));
    const body = VerifyBody.parse(raw ?? {});
    return Response.json(await getVerify(id, body.seed, access));
  } catch (e) {
    return errorResponse(e);
  }
}
