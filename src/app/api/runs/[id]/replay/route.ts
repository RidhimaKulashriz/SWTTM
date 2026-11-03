import { ReplayBody, errorResponse, readJson, startReplay } from "@/server/service";
import { authorizeGitHubUser } from "@/server/github-access";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = ReplayBody.parse(await readJson(req));
    // A supplied seed is a hash-verified MOCK run: it touches no private data and no real system, so no sign-in is needed.
    // Anonymous seeded replays are returned to the caller only; signed-in owners also get them saved to history.
    const denied = await authorizeGitHubUser();
    if (denied && !body.seed) return denied;
    return Response.json(await startReplay(id, body, { persist: !denied }), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
