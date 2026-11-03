import { z } from "zod";
import { resolveAccess } from "@/server/access";
import { errorResponse, getDiff } from "@/server/service";

export const dynamic = "force-dynamic";

const Q = z.object({ a: z.string().min(1), b: z.string().min(1), ignore: z.array(z.string().max(200)).max(20).default([]) });

export async function GET(req: Request) {
  try {
    const access = await resolveAccess(req);
    if (access instanceof Response) return access;
    const u = new URL(req.url).searchParams;
    const q = Q.parse({ a: u.get("a") ?? "", b: u.get("b") ?? "", ignore: u.getAll("ignore") });
    return Response.json(await getDiff(q.a, q.b, q.ignore, access), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
