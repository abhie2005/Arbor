import "server-only";

/**
 * Who else is looking at this.
 *
 * **The connection is the signal** (D-092). Presence is the set of live
 * `/api/live` streams and what each one says it is looking at — so there is no
 * table, no heartbeat from the browser, nothing to sweep, and no write anywhere
 * in it. Someone is here exactly as long as their stream is open; when they
 * close the tab, navigate away or lose the network, the request aborts and the
 * server finds out at once, which is the same moment a heartbeat scheme would
 * still be waiting out a timeout.
 *
 * That also keeps SSE honest. The argument for a stream rather than a socket
 * was that the browser has nothing to send (D-090), and presence looked like
 * the counter-example — until the connection turned out to *be* the message.
 * Changing what you are looking at reopens the stream, which costs one request
 * per navigation, next to the one the navigation was already making.
 *
 * **It is per-process, and that is a real limit.** A second server instance
 * knows nothing of the first's viewers, so with two Fargate tasks you would see
 * only the people who happen to share yours. The fix is the channel that is
 * already there — each process publishing its own set periodically, others
 * holding it with a TTL — and it is not built, because one process is what runs
 * today and a wrong guess about the shape of that message is more expensive
 * than the gap.
 */

export interface Watcher {
  userId: string;
  name: string;
  /** What they are looking at — a task id today. */
  scope: string;
}

interface Entry extends Watcher {
  /** Told when the people in this scope change. */
  notify: (scope: string) => void;
}

const entries = new Map<symbol, Entry>();

/**
 * Registers a stream as present, and returns how to remove it.
 *
 * Keyed by a symbol rather than by user id: one person can have three tabs
 * open on three tasks, and a map keyed by who they are would make each new tab
 * evict the last.
 */
export function arrive(entry: Entry): () => void {
  const key = Symbol("presence");
  entries.set(key, entry);
  announce(entry.scope);

  return () => {
    const leaving = entries.get(key);
    entries.delete(key);
    if (leaving) announce(leaving.scope);
  };
}

/** Everyone currently looking at one thing, each person once however many tabs. */
export function watching(scope: string): Watcher[] {
  const people = new Map<string, Watcher>();

  for (const entry of entries.values()) {
    if (entry.scope === scope) {
      people.set(entry.userId, { userId: entry.userId, name: entry.name, scope });
    }
  }

  return [...people.values()];
}

/**
 * Tells everyone on a scope that its set changed.
 *
 * Only the people already there hear it, which is also the access rule: a
 * stream is only registered on a scope its viewer was allowed to open, so
 * anyone receiving this had to pass that check first.
 */
function announce(scope: string): void {
  for (const entry of entries.values()) {
    if (entry.scope === scope) entry.notify(scope);
  }
}
