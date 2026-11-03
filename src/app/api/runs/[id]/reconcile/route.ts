import { z } from "zod";
import { TmError } from "@/core/types";
import { CONNECT_REQUIRED, requireLive, resolveAccess } from "@/server/access";
import { reconcile } from "@/server/reconcile";
import { SeedSchema, errorResponse, loadReplaySource } from "@/server/service";

export const dynamic = "force-dynamic";

const Body = z.object({ seed: SeedSchema.optional() });

/** Compare what a run recorded with what is actually on GitHub right now. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccess(req);
    if (access instanceof Response) return access;
    const denied = requireLive(access);
    if (denied) return denied;
    const { id } = await ctx.params;
    const body = Body.parse((await req.json().catch(() => ({}))) ?? {});
    const source = await loadReplaySource(id, body.seed, access);
    const snapshots = source.readSnapshots(id);
    if (access.kind !== "connection") throw new TmError(CONNECT_REQUIRED, 2);
    const creds = { token: access.connection.token, owner: access.connection.owner, repo: access.connection.repo };
    return Response.json(await reconcile(snapshots, creds), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
