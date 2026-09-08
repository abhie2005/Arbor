"use client";

import type { InboxRow } from "@arbor/db";
import Link from "next/link";
import { useState, useTransition } from "react";

import { markEverythingRead, markNotificationRead } from "@/server/inbox-actions";

import { relative } from "./relative-time";

/**
 * What is mine, anywhere.
 *
 * Every other screen in the app is a list of tasks in one container; this one
 * is a list of *events*, each pointing somewhere else. So the row is shaped
 * around the sentence — who did what — rather than around the task's fields,
 * and the task is the destination rather than the subject.
 *
 * **Nothing here joins anything.** The summary and the excerpt were rendered
 * when the notification was written, which is what the schema's `payload` is
 * for: the words a notification is about are the words as they were, and one
 * re-derived at read time would quietly change when the comment it describes is
 * edited.
 *
 * Opening a row marks it read as it navigates. The action is fired, not
 * awaited: this is client navigation, so the request outlives the row it came
 * from, and making someone wait for a write before the page they asked for
 * begins loading is a worse trade than a badge that lags by a moment. If it
 * fails, the row goes back to unread and says so — the same rule as every other
 * control (D-053): never show a state the server refused.
 */

const GLYPH: Record<string, string> = {
  assigned: "◎",
  mentioned: "@",
  replied: "↩",
};

export function Inbox({
  rows,
  unread,
  includeRead,
}: {
  rows: InboxRow[];
  /** The server's count, which is the whole inbox rather than this page of it. */
  unread: number;
  includeRead: boolean;
}) {
  const [, startTransition] = useTransition();
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  const [clearedAll, setClearedAll] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const isRead = (row: InboxRow) => row.isRead || clearedAll || marked.has(row.id);

  // Counted from the server's number, not from the rows: the list is one page
  // of the inbox and the badge is all of it, so subtracting what was just
  // marked is the only way the two agree while a request is in flight.
  const optimisticUnread = clearedAll
    ? 0
    : Math.max(0, unread - rows.filter((row) => !row.isRead && marked.has(row.id)).length);

  function mark(ids: string[], call: () => Promise<unknown>) {
    const fresh = ids.filter((id) => !marked.has(id));
    if (fresh.length === 0) return;

    setFailure(null);
    setMarked((was) => new Set([...was, ...fresh]));

    startTransition(async () => {
      try {
        await call();
      } catch (error) {
        setMarked((was) => new Set([...was].filter((id) => !fresh.includes(id))));
        setFailure(error instanceof Error ? error.message : "That did not save");
      }
    });
  }

  /**
   * Clearing everything is one call and one flag rather than a mark per row:
   * the server clears the whole inbox, including the rows beyond this page,
   * and pretending otherwise would leave the badge showing a number the button
   * has already dealt with.
   */
  function markAll() {
    if (optimisticUnread === 0) return;

    setFailure(null);
    setClearedAll(true);

    startTransition(async () => {
      try {
        await markEverythingRead();
      } catch (error) {
        setClearedAll(false);
        setFailure(error instanceof Error ? error.message : "That did not save");
      }
    });
  }

  return (
    <section className="inbox">
      <div className="inbox-head">
        <h1>Inbox</h1>
        <span className="inbox-count">
          {optimisticUnread === 0 ? "all read" : `${optimisticUnread} unread`}
        </span>

        <nav className="inbox-filter">
          <Link href="/inbox" aria-current={includeRead ? undefined : "page"}>
            Unread
          </Link>
          <Link href="/inbox?all=1" aria-current={includeRead ? "page" : undefined}>
            Everything
          </Link>
        </nav>

        <button
          type="button"
          className="inbox-clear"
          disabled={optimisticUnread === 0}
          onClick={markAll}
        >
          Mark all read
        </button>
      </div>

      {failure ? <p className="inbox-error">{failure}</p> : null}

      {rows.length === 0 ? (
        <p className="inbox-empty">
          {includeRead ? (
            "Nothing has been sent to you yet."
          ) : (
            <>
              Nothing unread. Being assigned a task, named in a comment or answered lands
              here — <Link href="/inbox?all=1">everything you have had</Link> is still there.
            </>
          )}
        </p>
      ) : (
        <ul className="inbox-list">
          {rows.map((row) => (
            <li key={row.id} className="inbox-item" data-read={isRead(row) || undefined}>
              <Link
                className="inbox-open"
                href={taskHref(row)}
                onClick={() => mark([row.id], () => markNotificationRead(row.id))}
              >
                <span className="inbox-kind" aria-hidden="true">
                  {GLYPH[row.kind] ?? "•"}
                </span>

                <span className="inbox-text">
                  <span className="inbox-summary">{row.summary}</span>
                  <span className="inbox-task">
                    {row.taskKey ? <span className="key">{row.taskKey}</span> : null}
                    {row.taskName}
                  </span>
                  {row.excerpt ? <span className="inbox-excerpt">{row.excerpt}</span> : null}
                </span>

                <time
                  className="inbox-when"
                  dateTime={row.createdAt}
                  title={new Date(row.createdAt).toLocaleString("en-GB")}
                >
                  {relative(row.createdAt)}
                </time>
              </Link>

              {/* A sibling of the link rather than inside it: a button in an
                  anchor is invalid, and reading something without opening it is
                  the whole reason this control exists. */}
              <button
                type="button"
                className="inbox-mark"
                disabled={isRead(row)}
                title={isRead(row) ? "Read" : "Mark read without opening"}
                onClick={() => mark([row.id], () => markNotificationRead(row.id))}
              >
                {isRead(row) ? "Read" : "Mark read"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The key, because that is what a person pastes into a message (D-031) — and
 * the id when there is no key, because `tasks.key` is nullable and a keyless
 * task still has to be reachable from its own notification.
 */
function taskHref(row: InboxRow): string {
  return `/t/${encodeURIComponent(row.taskKey ?? row.taskId ?? "")}`;
}
