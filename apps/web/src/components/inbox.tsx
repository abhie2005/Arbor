"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import type { InboxEntry } from "@/server/inbox";
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
 * **Two halves, one list** (D-088). A signal was written for you and can be
 * marked read on its own; an ambient row is a group of changes on something you
 * watch, and is cleared by the mark that clears the feed. The rows say which
 * they are with a glyph and by whether they offer the control — nothing else in
 * here branches on it.
 *
 * **Nothing joins anything.** A signal's summary was rendered when it was
 * written, which is what the schema's `payload` is for; an ambient summary is
 * composed by a pure function in core over what the query grouped. Neither
 * needs the task it names to be loaded.
 *
 * Opening a signal marks it read as it navigates. The action is fired, not
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
  ambient: "◇",
};

export function Inbox({
  entries,
  unread,
  watching,
  includeRead,
}: {
  entries: InboxEntry[];
  /** Unread signals across the whole inbox, not just this page of it. */
  unread: number;
  /** Watched tasks with something new on them. */
  watching: number;
  includeRead: boolean;
}) {
  const [, startTransition] = useTransition();
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  const [clearedAll, setClearedAll] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const isUnread = (entry: InboxEntry) =>
    entry.unread && !clearedAll && !marked.has(entry.key);

  // Counted from the server's numbers, not from the rows: the list is one page
  // of the inbox and the counts are all of it, so subtracting what was just
  // marked is the only way the two agree while a request is in flight.
  const outstanding = clearedAll
    ? 0
    : Math.max(0, unread - entries.filter((e) => e.unread && marked.has(e.key)).length);
  const stillWatching = clearedAll ? 0 : watching;

  function markOne(entry: InboxEntry) {
    if (!entry.notificationId || marked.has(entry.key)) return;
    const id = entry.notificationId;

    setFailure(null);
    setMarked((was) => new Set([...was, entry.key]));

    startTransition(async () => {
      try {
        await markNotificationRead(id);
      } catch (error) {
        setMarked((was) => new Set([...was].filter((key) => key !== entry.key)));
        setFailure(error instanceof Error ? error.message : "That did not save");
      }
    });
  }

  /**
   * Clearing everything is one call and one flag rather than a mark per row:
   * the server clears the whole inbox — including the rows beyond this page and
   * the ambient half, which has no per-row state to clear at all — and
   * pretending otherwise would leave counts the button has already dealt with.
   */
  function markAll() {
    if (outstanding === 0 && stillWatching === 0) return;

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
          {outstanding === 0 && stillWatching === 0
            ? "all read"
            : [
                outstanding > 0 ? `${outstanding} unread` : null,
                stillWatching > 0 ? `${stillWatching} watching` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
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
          disabled={outstanding === 0 && stillWatching === 0}
          onClick={markAll}
        >
          Mark all read
        </button>
      </div>

      {failure ? <p className="inbox-error">{failure}</p> : null}

      {entries.length === 0 ? (
        <p className="inbox-empty">
          {includeRead ? (
            "Nothing has been sent to you, and nothing has happened on what you watch."
          ) : (
            <>
              Nothing new. Being assigned a task, named in a comment or answered lands here,
              and so does anything that happens on a task you watch —{" "}
              <Link href="/inbox?all=1">everything you have had</Link> is still there.
            </>
          )}
        </p>
      ) : (
        <ul className="inbox-list">
          {entries.map((entry) => (
            <li
              key={entry.key}
              className="inbox-item"
              data-read={isUnread(entry) ? undefined : true}
              data-ambient={entry.source === "ambient" || undefined}
            >
              <Link
                className="inbox-open"
                href={taskHref(entry)}
                onClick={() => markOne(entry)}
              >
                <span className="inbox-kind" aria-hidden="true">
                  {GLYPH[entry.kind] ?? "•"}
                </span>

                <span className="inbox-text">
                  <span className="inbox-summary">{entry.summary}</span>
                  <span className="inbox-task">
                    {entry.taskKey ? <span className="key">{entry.taskKey}</span> : null}
                    {entry.taskName}
                  </span>
                  {entry.excerpt ? <span className="inbox-excerpt">{entry.excerpt}</span> : null}
                </span>

                <time
                  className="inbox-when"
                  dateTime={entry.at}
                  title={new Date(entry.at).toLocaleString("en-GB")}
                >
                  {relative(entry.at)}
                </time>
              </Link>

              {/* A sibling of the link rather than inside it: a button in an
                  anchor is invalid, and reading something without opening it is
                  the whole reason this control exists. An aggregate has no row
                  to mark, so it says what it stands for instead. */}
              {entry.source === "signal" ? (
                <button
                  type="button"
                  className="inbox-mark"
                  disabled={!isUnread(entry)}
                  title={isUnread(entry) ? "Mark read without opening" : "Read"}
                  onClick={() => markOne(entry)}
                >
                  {isUnread(entry) ? "Mark read" : "Read"}
                </button>
              ) : (
                <span
                  className="inbox-changes"
                  title="Activity on a task you watch. Cleared by 'Mark all read'."
                >
                  {entry.changes} change{entry.changes === 1 ? "" : "s"}
                </span>
              )}
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
function taskHref(entry: InboxEntry): string {
  return `/t/${encodeURIComponent(entry.taskKey ?? entry.taskId ?? "")}`;
}
