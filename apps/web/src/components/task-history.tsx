"use client";

import { summarizeChanges } from "@arbor/core";
import type { HistoryEntry } from "@arbor/db";

import { relative } from "./relative-time";

/**
 * What has happened to this task.
 *
 * The first reader `activity` has ever had. Every operation has written a row
 * there since Phase 2 — it is what undo replays against and what the ambient
 * inbox aggregates — and until now the only way to see one was `psql`.
 *
 * **The sentence comes from the same pure function the inbox uses.**
 * `summarizeChanges` over a single change is "changed status", "commented",
 * "created it". One vocabulary for both screens, so a verb cannot read one way
 * in an inbox and another way in a history — and adding an operation gives it a
 * phrase in both places at once.
 *
 * **The values are resolved here, not stored resolved.** The log holds ids,
 * because it is a record of what an operation did and an operation names things
 * by id. What a status id *means* is on the page already — the picker needs the
 * same list — so the row renders "Todo → In Review" without a single extra
 * query. Where the page has no way to name a value (a custom field's id, a
 * container), the entry says what changed and leaves it at that: a uuid on
 * screen is worse than no detail.
 */

const PRIORITY_NAMES: Record<string, string> = {
  "1": "Urgent",
  "2": "High",
  "3": "Normal",
  "4": "Low",
};

export interface HistoryLookups {
  statuses: { id: string; name: string }[];
  taskTypes: { id: string; name: string }[];
  people: { id: string; name: string }[];
}

export function TaskHistory({
  entries,
  lookups,
}: {
  entries: HistoryEntry[];
  lookups: HistoryLookups;
}) {
  if (entries.length === 0) {
    return (
      <section className="detail-section history">
        <h2>History</h2>
        <p className="history-empty">Nothing has happened to this task yet.</p>
      </section>
    );
  }

  return (
    <section className="detail-section history">
      <h2>
        History<span className="history-count">{entries.length}</span>
      </h2>

      <ol className="history-list">
        {entries.map((entry) => {
          const from = describeValue(entry.field, entry.from, lookups);
          const to = describeValue(entry.field, entry.to, lookups);

          return (
            <li key={entry.id} className="history-entry">
              <span className="history-who">{entry.actorName ?? "Someone"}</span>{" "}
              <span className="history-what">
                {summarizeChanges([{ verb: entry.verb, field: entry.field }], 1)}
              </span>
              {/* The colon is what makes every line parse the same way. Without
                  it, "changed assignees Avery Mills" reads as a run-on, while
                  "changed status Todo → In Progress" happens to survive on the
                  strength of the arrow. */}
              {from || to ? (
                <span className="history-values">
                  <span className="history-colon">:</span>
                  {from ? <span className="history-from">{from}</span> : null}
                  {from && to ? <span className="history-arrow">→</span> : null}
                  {to ? <span className="history-to">{to}</span> : null}
                </span>
              ) : null}
              <time
                className="history-when"
                dateTime={entry.at}
                title={new Date(entry.at).toLocaleString("en-GB")}
              >
                {relative(entry.at)}
              </time>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * A stored value, in words — or nothing.
 *
 * Nothing is a real answer here. A rename's old value is a whole sentence, a
 * custom field's is keyed by an id this page cannot resolve, and a description
 * change stores a document. In each case the phrase above already says what
 * happened, and printing the raw value would be noise at best and a uuid at
 * worst.
 */
function describeValue(
  field: string | null,
  value: unknown,
  lookups: HistoryLookups,
): string | null {
  if (value === null || value === undefined || value === "") return null;

  switch (field) {
    case "status_id":
      return lookups.statuses.find((status) => status.id === value)?.name ?? null;

    case "task_type_id":
      return lookups.taskTypes.find((type) => type.id === value)?.name ?? null;

    case "assignee":
    case "watcher":
      return lookups.people.find((person) => person.id === value)?.name ?? null;

    case "priority":
      return PRIORITY_NAMES[String(value)] ?? null;

    case "points":
      return String(value);

    // Dates are stored as instants and rendered as days here: a history line is
    // "moved the due date to the 12th", not a timestamp to the second (D-067).
    case "due_at":
    case "start_at":
      return typeof value === "string"
        ? new Date(value).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            timeZone: "UTC",
          })
        : null;

    case "name":
      return typeof value === "string" ? `“${value}”` : null;

    default:
      return null;
  }
}
