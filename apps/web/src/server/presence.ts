import "server-only";

import { randomUUID } from "node:crypto";

import { type PresenceMessage, publishPresence, subscribeToPresence } from "@arbor/db";

/**
 * Who else is looking at this.
 *
 * **The connection is the signal** (D-092). Presence is the set of live
 * `/api/live` streams and what each one says it is looking at — so there is no
 * table, no sweep, and no write anywhere in it. Someone is here exactly as long
 * as their stream is open; when they close the tab, navigate away or lose the
 * network, the request aborts and the server finds out at once, which is the
 * same moment a heartbeat scheme would still be waiting out a timeout.
 *
 * That also keeps SSE honest. The argument for a stream rather than a socket
 * was that the browser has nothing to send (D-090), and presence looked like
 * the counter-example — until the connection turned out to *be* the message.
 *
 * **Between processes there is no shared connection to be the signal**, so the
 * second half of this file is the part D-092 left unbuilt: each process states
 * its own set on the channel that already exists, and holds everyone else's
 * with a TTL (D-100). The heartbeat the single-process design was proud of not
 * needing is unavoidable here — a process that is killed cannot say so — and it
 * is one message per server per ten seconds rather than one per browser, which
 * is the difference that made it worth avoiding in the first place.
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
 * This process, for as long as it lives.
 *
 * Not a hostname and not a pid: two processes on one host would collide, and a
 * pid is reused. It only has to be unique among whoever is talking right now.
 */
const PROCESS = randomUUID();

/** What other processes last said: scope, then which process said it. */
const remote = new Map<string, Map<string, { people: Watcher[]; at: number }>>();

/**
 * How long another process's word is good for, and how often to give ours.
 *
 * The ratio is what matters: three heartbeats have to be missed before a set is
 * dropped, so one slow tick does not empty a room. The absolute numbers are
 * chosen against the cost of being wrong — a viewer who has gone lingers for at
 * most half a minute, and half a minute of a stale name is better than a name
 * that flickers because a server paused for GC.
 */
const REMOTE_TTL_MS = 30_000;
const HEARTBEAT_MS = 10_000;

let listening: Promise<unknown> | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

/**
 * Registers a stream as present, and returns how to remove it.
 *
 * Keyed by a symbol rather than by user id: one person can have three tabs open
 * on three tasks, and a map keyed by who they are would make each new tab evict
 * the last.
 */
export function arrive(entry: Entry): () => void {
  const key = Symbol("presence");
  entries.set(key, entry);

  void start();
  announce(entry.scope);
  void state(entry.scope);

  return () => {
    const leaving = entries.get(key);
    entries.delete(key);
    if (!leaving) return;

    announce(leaving.scope);
    // Published even when it empties the scope, because an empty set is the
    // message: it is how the other processes learn somebody left rather than
    // waiting out the TTL.
    void state(leaving.scope);
    if (entries.size === 0) stopHeartbeat();
  };
}

/**
 * Everyone currently looking at one thing — each person once, however many tabs
 * and however many servers.
 *
 * Remote sets are aged on read rather than swept on a timer. There is nothing
 * to leak, a scope nobody asks about costs one map entry, and a sweep would be
 * a second clock to reason about.
 */
export function watching(scope: string): Watcher[] {
  const people = new Map<string, Watcher>();

  for (const entry of entries.values()) {
    if (entry.scope === scope) {
      people.set(entry.userId, { userId: entry.userId, name: entry.name, scope });
    }
  }

  const held = remote.get(scope);
  if (held) {
    const now = Date.now();
    for (const [process, said] of held) {
      if (now - said.at > REMOTE_TTL_MS) {
        held.delete(process);
        continue;
      }
      for (const person of said.people) people.set(person.userId, person);
    }
    if (held.size === 0) remote.delete(scope);
  }

  return [...people.values()];
}

/** This process's own view of one scope, as everyone else will hear it. */
function localOn(scope: string): { id: string; name: string }[] {
  const people = new Map<string, string>();
  for (const entry of entries.values()) {
    if (entry.scope === scope) people.set(entry.userId, entry.name);
  }
  return [...people].map(([id, name]) => ({ id, name }));
}

/** Every scope this process currently has somebody on. */
function localScopes(): string[] {
  return [...new Set([...entries.values()].map((entry) => entry.scope))];
}

/**
 * States this process's set for one scope.
 *
 * The whole set, never a delta. A delta needs the receiver to have heard every
 * previous message, and a process that started ten seconds ago has not — which
 * is exactly the case this whole mechanism exists for.
 */
async function state(scope: string): Promise<void> {
  try {
    await publishPresence({ p: PROCESS, k: "here", s: scope, v: localOn(scope) });
  } catch {
    // A failed publish costs the other processes one TTL of staleness. It must
    // not cost this one its stream.
  }
}

function start(): Promise<unknown> {
  listening ??= subscribeToPresence(receive).catch(() => {
    // Cleared rather than retried with a backoff, so the next arrival tries
    // again: presence is worth degrading to per-process, and never worth
    // failing a connection over.
    listening = null;
  });

  if (!heartbeat) {
    heartbeat = setInterval(() => {
      for (const scope of localScopes()) void state(scope);
    }, HEARTBEAT_MS);
    // Node should still be able to exit with this pending.
    heartbeat.unref?.();
  }

  return listening;
}

function stopHeartbeat(): void {
  if (!heartbeat) return;
  clearInterval(heartbeat);
  heartbeat = null;
  // The subscription stays. It costs nothing while nobody is here, and the next
  // arrival would only have to set it up again.
}

function receive(message: PresenceMessage): void {
  if (message.p === PROCESS) return;

  // Somebody just started and is asking what everyone can see. Answering makes
  // joining immediate instead of one heartbeat away — which matters, because
  // the heartbeat is the only other thing that would ever have told them.
  if (message.k === "who") {
    for (const scope of localScopes()) void state(scope);
    return;
  }

  if (!message.s) return;
  const scope = message.s;

  const held = remote.get(scope) ?? new Map<string, { people: Watcher[]; at: number }>();
  held.set(message.p, {
    at: Date.now(),
    people: (message.v ?? []).map((person) => ({
      userId: person.id,
      name: person.name,
      scope,
    })),
  });
  remote.set(scope, held);

  announce(scope);
}

/**
 * Asks the others to state theirs.
 *
 * Called when a stream opens on a scope this process has nobody else on, which
 * is the moment its own view is most likely to be incomplete. Without it a new
 * viewer sees an empty room for up to one heartbeat, which is exactly the
 * moment they are looking.
 */
export async function askWhoIsThere(): Promise<void> {
  await start();
  try {
    await publishPresence({ p: PROCESS, k: "who" });
  } catch {
    // The next heartbeat fills it in.
  }
}

/**
 * Tells everyone on a scope that its set changed.
 *
 * Only the people already there hear it, which is also the access rule: a
 * stream is registered on a scope only if its viewer was allowed to open it, so
 * anyone receiving this had to pass that check first.
 */
function announce(scope: string): void {
  for (const entry of entries.values()) {
    if (entry.scope === scope) entry.notify(scope);
  }
}
