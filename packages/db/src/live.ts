import { Client } from "pg";

import { connectionString } from "./client";

/**
 * Live changes, over Postgres `LISTEN`/`NOTIFY`.
 *
 * **A nudge, not a delta** (D-090). What crosses the wire is "something changed
 * in list L, by person A" — never what changed. The screens are server
 * components, so the cheapest correct way to show a change is to re-render them
 * (`router.refresh()`); sending the change itself would mean a second
 * description of every mutation, in a second shape, kept in step with the first
 * by hand. Deltas are what a CRDT editor needs, and Docs are Phase 9.
 *
 * **No new deployable and no Redis.** The database everything already talks to
 * has a pub/sub that is transactional, and a Next route handler can hold a
 * stream open. `apps/realtime` stays a name in the README until presence or
 * deltas make it earn its keep.
 */

/** One channel for the whole workspace. Fan-out is the subscriber's problem. */
export const LIVE_CHANNEL = "arbor_live";

export interface Change {
  /** Workspace the change happened in. */
  w: string;
  /** The list it happened in — what a subscriber's access is checked against. */
  l: string;
  /** Who did it, so a client can ignore its own echo. */
  a: string;
  /**
   * Whose timer started or stopped, when that is what this change was.
   *
   * **The one thing a nudge says about itself** (D-098). Everything else here
   * is deliberately about *where* a change happened rather than what it was,
   * because the browser answers a nudge by re-rendering and the re-render is
   * the update. A running timer is the case that breaks: it is per-person
   * global state, the echo filter drops your own changes so a second tab never
   * hears about them, and a stale readout is not merely late — it claims a
   * timer is running on a task where it has already been stopped.
   *
   * It names a person, never a task. The route answers it by looking up that
   * viewer's own running entry, so this leaks nothing it did not already know.
   */
  t?: string;
}

/**
 * Announces a change on the connection that made it.
 *
 * **Called inside the transaction, and that is the whole trick.** `NOTIFY` is
 * transactional: Postgres delivers it at commit and discards it on rollback. So
 * a nudge cannot describe a change that did not happen, and this needs no
 * after-commit hook, no outbox table and no worker — the three things that make
 * "publish after write" hard everywhere else.
 *
 * The payload is deliberately identical for every operation in a batch that
 * touches the same list. Postgres collapses duplicate notifications with the
 * same channel and payload inside one transaction, so a bulk edit of two
 * hundred tasks in one list delivers **one** nudge rather than two hundred,
 * without anything here having to deduplicate.
 */
export async function announceChange(
  client: { query: (text: string, values: unknown[]) => Promise<unknown> },
  change: Change,
): Promise<void> {
  await client.query(`SELECT pg_notify($1, $2)`, [LIVE_CHANNEL, JSON.stringify(change)]);
}

type Listener = (change: Change) => void;

/**
 * One connection per process, however many people are watching.
 *
 * A `LISTEN` occupies its connection for as long as it lasts, so taking one
 * from the pool per browser tab would exhaust the pool at ten tabs. Instead the
 * process holds a single dedicated client and hands every subscriber a copy of
 * what arrives — which is also why this is a module singleton rather than
 * something a request creates.
 */
let hub: Hub | null = null;

class Hub {
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private readonly listeners = new Set<Listener>();
  private closed = false;

  async add(listener: Listener): Promise<() => void> {
    this.listeners.add(listener);
    await this.ensureConnected();

    return () => {
      this.listeners.delete(listener);
      // The connection stays. Reconnecting costs more than an idle listener,
      // and in a server process there is almost always another subscriber
      // along in a moment.
    };
  }

  private async ensureConnected(): Promise<void> {
    if (this.client || this.closed) return;
    this.connecting ??= this.connect();
    await this.connecting;
  }

  private async connect(): Promise<void> {
    const client = new Client({ connectionString: connectionString() });

    client.on("notification", (message) => {
      if (message.channel !== LIVE_CHANNEL || !message.payload) return;

      let change: Change;
      try {
        change = JSON.parse(message.payload) as Change;
      } catch {
        // A payload that will not parse is a bug in the publisher, not a reason
        // to tear down every stream in the process.
        return;
      }

      for (const listener of this.listeners) listener(change);
    });

    // A dropped connection is silent otherwise: the stream stays open and
    // simply stops being live, which is the failure nobody notices.
    client.on("error", () => void this.reconnect());
    client.on("end", () => void this.reconnect());

    await client.connect();
    await client.query(`LISTEN ${LIVE_CHANNEL}`);
    this.client = client;
  }

  private async reconnect(): Promise<void> {
    if (this.closed) return;

    this.client = null;
    this.connecting = null;
    if (this.listeners.size === 0) return;

    // Flat delay rather than a backoff: the only realistic cause here is the
    // database restarting, and a second is short enough to be invisible and
    // long enough not to spin.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await this.ensureConnected().catch(() => void this.reconnect());
  }
}

/**
 * Subscribes to every change in the process. Returns the unsubscribe.
 *
 * **It hands over everything, unfiltered.** Deciding who may hear about a
 * change needs the viewer, and this layer has no viewer — the route handler
 * that does checks each nudge against `access_index` before writing it to a
 * stream (D-090). Filtering here would mean either a permission rule in the
 * transport or a channel per user, and a channel per user is a fan-out the
 * whole notifications design exists to avoid.
 */
export async function subscribeToChanges(listener: Listener): Promise<() => void> {
  hub ??= new Hub();
  return hub.add(listener);
}
