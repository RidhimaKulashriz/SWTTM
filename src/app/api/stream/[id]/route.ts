import { channel } from "@/server/service";
import { authorizeGitHubUser } from "@/server/github-access";

export const dynamic = "force-dynamic";

/** Server-Sent Events: emits `step` events live while a run/replay started with the same streamId executes. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await authorizeGitHubUser();
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return Response.json({ error: "Invalid stream id" }, { status: 400 });
  const chan = channel(id);
  const enc = new TextEncoder();
  let unsub: (() => void) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (e: { type: string; data: unknown }) => {
        controller.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`));
        if (e.type === "done") {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };
      controller.enqueue(enc.encode(": connected\n\n"));
      chan.events.forEach(send);
      if (!chan.done) {
        chan.subs.add(send);
        unsub = () => chan.subs.delete(send);
      }
      req.signal.addEventListener("abort", () => unsub?.());
    },
    cancel() {
      unsub?.();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
