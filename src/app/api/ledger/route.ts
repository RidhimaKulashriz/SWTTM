import { errorResponse, getLedger } from "@/server/service";
import { authorizeGitHubUser } from "@/server/github-access";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const denied = await authorizeGitHubUser();
    if (denied) return denied;
    return Response.json(await getLedger());
  } catch (e) {
    return errorResponse(e);
  }
}
