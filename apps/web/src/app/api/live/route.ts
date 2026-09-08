import { type Change, pool, subscribeToChanges } from "@arbor/db";

import { getCurrentUser } from "@/server/auth";

/**
 * `/api/live` — the stream every screen listens to.
 *
 * The first route handler in the app, and the first thing that is not a page or
 * a server action. It exists because a server action cannot push: the app finds
 * out about its own writes when it re-renders after one, and finds out about
 * everybody else's never (D-090).
 *
 * **Server-Sent Events rather than a WebSocket.** The traffic is one-directional
 * — the server says "something changed", the browser says nothing back — and
 * `EventSource` reconnects on its own, which is the entire body of code a
 * WebSocket would have made us write. A socket becomes worth it when the
 * browser has something to send, which is presence.
 */

export const dynamic = "force-dynamic";
/** `pg` and a long-lived connection: this is not an edge function. */
export const runtime = "nodejs";

/**
 * Proxies and browsers both give up on a silent connection. A comment line is
 * the protocol's own keep-alive and costs three bytes.
 */
const HEARTBEAT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
  const viewer = await getCurrentUser();

  // No redirect: this is not a page. A client with no session should be told
  // plainly so `EventSource` stops retrying against a wall.
  if (!viewer) return new Response("Not signed in", { status: 401 });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;

      const send = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The client went away between the check and the write.
          open = false;
        }
      };

      /**
       * **Every nudge is checked against this viewer's access.**
       *
       * The channel carries every change in the process, because the transport
       * has no idea who is listening (`live.ts`). This is where it finds out.
       * Without this, the stream would tell anyone with a session that
       * *something* changed in a list they cannot open — which is exactly the
       * existence leak the refusals are careful not to be (D-080).
       *
       * One indexed lookup per nudge per viewer. It could be cached per
       * connection, and it is not: a cache would have a stale window in which a
       * revoked person still hears about a list, and "grants are truth, the
       * index is what queries join" (ADR 3) is not a rule to make approximate
       * for a keep-alive.
       */
      const mayHear = async (change: Change): Promise<boolean> => {
        const result = await pool().query(
          `SELECT 1 FROM access_index WHERE list_id = $1 AND principal_id = $2`,
          [change.l, viewer.id],
        );
        return result.rowCount === 1;
      };

      const unsubscribe = await subscribeToChanges((change) => {
        void mayHear(change).then((allowed) => {
          if (allowed) send(`data: ${JSON.stringify(change)}\n\n`);
        });
      });

      const heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);

      // Named so the browser can tell "connected" from "reconnected", and so a
      // stream that opens but never delivers is visibly a filter problem rather
      // than a transport one.
      send(`event: ready\ndata: {}\n\n`);

      const close = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // nginx buffers proxied responses by default, which turns a live stream
      // into a very slow file. The reference deployment terminates at an ALB,
      // but this header costs nothing and saves an afternoon.
      "X-Accel-Buffering": "no",
    },
  });
}
