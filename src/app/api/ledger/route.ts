import { resolveAccess } from "@/server/access";
import { errorResponse, getLedger } from "@/server/service";

export const dynamic = "force-dynamic";

export async function GET(req?: Request) {
  try {
    const access = await resolveAccess(req);
    if (access instanceof Response) return access;
    return Response.json(await getLedger(access), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
