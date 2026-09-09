import { type Change, pool, runningEntryFor, subscribeToChanges, taskAccess } from "@arbor/db";

import { getCurrentUser } from "@/server/auth";
import { arrive, watching } from "@/server/presence";

/**
 * `/api/live` — the stream every screen listens to.
 *
 * The first route handler in the app, and the only place a change meets a
 * viewer before it leaves the server. It exists because a server action cannot
 * push: the app finds out about its own writes when it re-renders after one,
 * and finds out about everybody else's never (D-090).
 *
 * **Server-Sent Events rather than a WebSocket.** The traffic is
 * one-directional — the server says "something changed", the browser says
 * nothing back — and `EventSource` reconnects on its own, which is the entire
 * body of code a WebSocket would have made us write. Presence looked like the
 * case that would break that, and did not: `?scope=` is the browser saying
 * where it is, once, by opening the connection there (D-092).
 *
 * Three kinds of message go down it. A `change` is a nudge — "something happened
 * in list L" — and the page answers by re-rendering itself. A `presence` is the
 * data itself, the people currently on this scope, because presence is
 * ephemeral and re-rendering a page every time somebody's tab moves would be
 * absurd. A `timer` is the third and the newest (D-098): what this viewer has
 * running, sent as data for the same reason presence is, and sent *past* the
 * echo filter because your own timer started in another tab is precisely the
 * change the echo filter was built to drop.
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

  /**
   * What this stream is looking at, if anything.
   *
   * **Checked, not trusted.** Anyone can put a task id in a query string, and
   * "who is looking at this" is exactly the kind of thing that must not answer
   * for a task the asker cannot open — it would report activity on a private
   * list to someone with no grant on it, which is the existence leak the
   * refusals are careful not to be (D-080).
   */
  const requested = new URL(request.url).searchParams.get("scope");
  const scope = requested && (await taskAccess(requested, viewer.id)) ? requested : null;

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
       * **Who *else* is here** — this viewer is filtered out before the payload
       * is built, not after it arrives.
       *
       * The server is the only side that knows which stream belongs to whom, so
       * doing it here makes the message mean exactly what the screen says. A
       * payload that includes you and a client that removes you again are two
       * places to hold the same rule, and the client's copy is the one that
       * would be missed by a second consumer.
       */
      const sendPresence = (which: string) => {
        const others = watching(which)
          .filter((person) => person.userId !== viewer.id)
          .map((person) => ({ id: person.userId, name: person.name }));

        send(`event: presence\ndata: ${JSON.stringify({ scope: which, people: others })}\n\n`);
      };

      /**
       * This viewer's running timer, looked up fresh.
       *
       * **Not filtered by access, and it does not need to be**: the query is
       * scoped to the viewer's own id, so this can only ever describe their own
       * row. It carries the task's key only when the viewer can still reach it
       * (`runningEntryFor`), so a grant revoked mid-timer leaves the readout
       * saying "a task" rather than naming one (D-095).
       */
      const sendTimer = async () => {
        try {
          const running = await runningEntryFor(viewer.id);
          send(`event: timer\ndata: ${JSON.stringify({ running })}\n\n`);
        } catch {
          // A failed lookup is a stale readout, not a reason to close a stream
          // that is still delivering everything else.
        }
      };

      /**
       * **Every nudge is checked against this viewer's access.**
       *
       * The channel carries every change in the process, because the transport
       * has no idea who is listening (`live.ts`). This is where it finds out.
       * Without this, the stream would tell anyone with a session that
       * *something* changed in a list they cannot open.
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
        // Before the access check and outside it. A timer nudge names a person,
        // this stream belongs to one, and the answer is built from that
        // person's own row — so the list the change happened in is not a gate
        // on it, and must not be: stopping your own timer never needs access to
        // the task it was spent on (D-095).
        if (change.t === viewer.id) void sendTimer();

        void mayHear(change).then((allowed) => {
          if (allowed) send(`data: ${JSON.stringify(change)}\n\n`);
        });
      });

      // Registered after the subscription so a stream cannot be announced as
      // present and then fail to open.
      const depart = scope
        ? arrive({
            userId: viewer.id,
            name: viewer.name,
            scope,
            notify: sendPresence,
          })
        : null;

      const heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);

      // Named so the browser can tell "connected" from "reconnected", and so a
      // stream that opens but never delivers is visibly a filter problem rather
      // than a transport one.
      send(`event: ready\ndata: {}\n\n`);

      const close = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        // Leaving before unsubscribing, so the people still here are told by a
        // process that is still able to tell them.
        depart?.();
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
