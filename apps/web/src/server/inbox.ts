import "server-only";

import {
  type AmbientRow,
  type InboxRow,
  type RunningEntry,
  activitySeen,
  loadAmbient,
  loadInbox,
  runningEntryFor,
  unreadCount,
} from "@arbor/db";
import { cache } from "react";

/**
 * Reading someone's inbox, for the screens that show it.
 *
 * Thin over `@arbor/db`, which holds both halves and scopes both of them: the
 * direct signals written by the fan-out, and the ambient activity assembled at
 * read time for whatever the viewer watches. What this file adds is the merge —
 * and the merge is the part with an opinion in it (D-088).
 */

export type { AmbientRow, InboxRow };

/** Cap the page rather than the query: an inbox is a queue, not an archive. */
const PAGE_SIZE = 100;

/**
 * How far back "everything" looks.
 *
 * The direct half has no window — a notification is a row, and it stays until
 * it is cleared. The ambient half has to have one, because it is derived from a
 * log that only grows, and "everything that ever happened on twelve tasks you
 * watch" is not a screen anybody reads.
 */
const WINDOW_DAYS = 14;

/** What a first visit shows, before there is a mark to measure from. */
const FIRST_VISIT_DAYS = 7;

/**
 * One row of the inbox, whichever half it came from.
 *
 * Flattened deliberately. The two halves differ in nearly every way that
 * matters underneath — one is a row per event with its own read flag, the other
 * is a group of events with a shared mark — and a renderer that has to know
 * which is which in six places will get one of them wrong. So the difference is
 * carried by exactly two fields: `source`, which picks the glyph, and
 * `notificationId`, which is null for anything that cannot be marked read on its
 * own.
 */
export interface InboxEntry {
  /** Stable across renders: a notification id, or the task an aggregate is for. */
  key: string;
  source: "signal" | "ambient";
  /** Null for an aggregate — there is no single row to mark (D-088). */
  notificationId: string | null;
  at: string;
  unread: boolean;
  summary: string;
  taskId: string | null;
  taskKey: string | null;
  taskName: string;
  /** The words a comment said. Signals only. */
  excerpt: string | null;
  /** How many events the line stands for. Ambient only. */
  changes: number | null;
  kind: string;
}

export interface InboxPage {
  entries: InboxEntry[];
  /** Unread direct signals — the badge's number, and only ever that. */
  unread: number;
  /** Watched tasks with something new on them since the mark. */
  watching: number;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Both halves, merged into one stream.
 *
 * The two queries are independent, so they run together — and the merge is a
 * sort on a timestamp both halves already have, which is what makes one list
 * possible at all: an event and a group of events both happened *at* a time.
 */
export const loadInboxPage = cache(
  async (userId: string, workspaceId: string, includeRead: boolean): Promise<InboxPage> => {
    const seenAt = await activitySeen(userId, workspaceId);

    // "Everything" ignores the mark and shows the window; "unread" starts at
    // the mark, floored by the window so a month away is not a month of rows.
    const floor = daysAgo(WINDOW_DAYS);
    const start = seenAt ?? daysAgo(FIRST_VISIT_DAYS);
    const since = includeRead ? floor : start > floor ? start : floor;

    const [signals, ambient] = await Promise.all([
      loadInbox(userId, { includeRead, limit: PAGE_SIZE }),
      loadAmbient(userId, workspaceId, { since, seenAt, limit: PAGE_SIZE }),
    ]);

    const entries = [...signals.map(fromSignal), ...ambient.map(fromAmbient)]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, PAGE_SIZE);

    return {
      entries,
      unread: signals.filter((row) => !row.isRead).length,
      watching: ambient.filter((row) => row.isNew).length,
    };
  },
);

function fromSignal(row: InboxRow): InboxEntry {
  return {
    key: row.id,
    source: "signal",
    notificationId: row.id,
    at: row.createdAt,
    unread: !row.isRead,
    summary: row.summary,
    taskId: row.taskId,
    taskKey: row.taskKey,
    taskName: row.taskName,
    excerpt: row.excerpt,
    changes: null,
    kind: row.kind,
  };
}

function fromAmbient(row: AmbientRow): InboxEntry {
  return {
    // Prefixed, because a task id and a notification id are both uuids and one
    // list holding both must not collide on a React key.
    key: `task:${row.taskId}`,
    source: "ambient",
    notificationId: null,
    at: row.lastAt,
    unread: row.isNew,
    summary: row.summary,
    taskId: row.taskId,
    taskKey: row.taskKey,
    taskName: row.taskName,
    excerpt: null,
    changes: row.changes,
    kind: "ambient",
  };
}

/**
 * The sidebar's number.
 *
 * `cache` is what makes the shell able to fetch this for itself (D-085).
 *
 * **Direct signals only, deliberately.** The badge is a count of things
 * addressed to *you* — assigned, mentioned, replied — and a number that also
 * counted every task somebody touched would be large, mostly ignorable, and
 * therefore ignored. The ambient half is a feed you visit, not a queue that
 * demands you.
 *
 * Null rather than a throw when the database is unreachable: this runs inside
 * the chrome of every screen, and the pages already have a considered answer
 * for a missing database.
 */
export const inboxBadge = cache(async (userId: string): Promise<number | null> => {
  try {
    return await unreadCount(userId);
  } catch {
    return null;
  }
});

/**
 * The viewer's running timer, for the shell.
 *
 * Lives beside `inboxBadge` because it is the same kind of thing and answers to
 * the same rule (D-085): chrome that belongs to the person rather than to the
 * screen fetches itself, so no page has to remember to pass it. `cache` means a
 * screen that also wants it — the task detail page does not, it has the entries
 * themselves — costs one query rather than two.
 *
 * Null rather than a throw when the database is unreachable, for the same
 * reason the badge does it: this runs inside every screen's chrome, and a
 * missing database must not take down the page that explains how to start one.
 */
export const shellTimer = cache(async (userId: string): Promise<RunningEntry | null> => {
  try {
    return await runningEntryFor(userId);
  } catch {
    return null;
  }
});
