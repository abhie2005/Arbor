import "server-only";

import { type InboxRow, loadInbox, unreadCount } from "@arbor/db";
import { cache } from "react";

/**
 * Reading someone's inbox, for the screens that show it.
 *
 * Thin on purpose: the queries live in `@arbor/db` and are scoped there — both
 * of them join `access_index` on each row's own list, so a notification about a
 * task the viewer has since lost access to is neither listed nor counted. What
 * this file adds is the per-request memoisation, because the badge and the page
 * ask the same question on the same render.
 */

export type { InboxRow };

/** Cap the page rather than the query: an inbox is a queue, not an archive. */
const PAGE_SIZE = 100;

export const loadInboxRows = cache(
  async (userId: string, includeRead: boolean): Promise<InboxRow[]> =>
    loadInbox(userId, { includeRead, limit: PAGE_SIZE }),
);

/**
 * The sidebar's number.
 *
 * `cache` is what makes the shell able to fetch this for itself (D-085): the
 * inbox page renders the sidebar *and* wants the same count for its own header,
 * and React collapses the two calls into one query for the request.
 *
 * **Null rather than a throw when the database is unreachable.** This runs
 * inside the chrome of every screen, and the pages already have a considered
 * answer for a missing database (`LoadFailure`). A count that cannot be taken
 * must not be the thing that turns a working page into a stack trace.
 */
export const inboxBadge = cache(async (userId: string): Promise<number | null> => {
  try {
    return await unreadCount(userId);
  } catch {
    return null;
  }
});
