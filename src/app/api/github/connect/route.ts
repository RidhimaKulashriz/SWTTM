import { resolveAccess, verifyConnection } from "@/server/access";

export const dynamic = "force-dynamic";

/** Verify the visitor's own token + repository against GitHub. Nothing is stored; the token stays in their browser. */
export async function POST(req: Request) {
  const access = await resolveAccess(req);
  if (access instanceof Response) return access;
  if (access.kind !== "connection") {
    return Response.json({ error: "Send a GitHub token and repository to connect.", code: "connect_required" }, { status: 400 });
  }
  const c = access.connection;
  const v = await verifyConnection(c.token, `${c.owner}/${c.repo}`);
  return Response.json({ connected: true, ...v.info }, { headers: { "Cache-Control": "no-store" } });
}
