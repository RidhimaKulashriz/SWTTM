import { z } from "zod";
import { TmError } from "@/core/types";
import { githubEnvironment } from "@/executors/github";
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
    const env = githubEnvironment();
    const creds =
      access.kind === "connection"
        ? { token: access.connection.token, owner: access.connection.owner, repo: access.connection.repo }
        : { token: env.token ?? "", owner: env.owner ?? "", repo: env.repo ?? "" };
    if (!creds.token || !creds.owner || !creds.repo) throw new TmError(CONNECT_REQUIRED, 2);
    return Response.json(await reconcile(snapshots, creds), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
