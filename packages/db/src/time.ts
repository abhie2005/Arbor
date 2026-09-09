import { type TimeEntryValues, entryDurationMs } from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";

/**
 * Reading tracked time. Writing it is `applyOperations` (D-093).
 *
 * There is no `startTimer` here, for the same reason there is no
 * `createComment` in `comments.ts`: a service with its own INSERT would be the
 * second thing in the system that writes, and the second writer is the one that
 * forgets to log. This file loads and answers questions; the executor writes.
 *
 * The one thing it does that a pure reader would not is `runningEntryFor`,
 * which the *action* uses to build the batch that stops one timer and starts
 * another. Reading in order to construct an operation is still reading.
 */

type Connection = Pool | PoolClient;

export interface TimeEntryRecord {
  id: string;
  taskId: string;
  userId: string;
  userName: string | null;
  startedAt: string;
  /** Null means it is running right now. */
  endedAt: string | null;
  /**
   * What the row stores, which is null while it runs.
   *
   * A running entry's length is `entryDurationMs` against a clock, not a
   * column — the denormalization happens on stop, and pretending otherwise
   * here would mean a number that goes stale the moment it is read.
   */
  durationMs: number | null;
  description: string | null;
  isBillable: boolean;
}

/** A timer in progress, and enough about its task to link to it. */
export interface RunningEntry {
  id: string;
  taskId: string;
  startedAt: string;
  description: string | null;
  isBillable: boolean;
  /**
   * The task's key and name, or null when the viewer can no longer reach it.
   *
   * Null rather than omitting the timer: an entry you cannot see is an entry
   * you cannot stop, and it would keep accruing against a task you have been
   * removed from. The readout says "a task" and the stop button still works —
   * stopping your own time never needs access to what it was spent on
   * (D-095).
   */
  taskKey: string | null;
  taskName: string | null;
}

interface EntryRow {
  id: string;
  task_id: string;
  user_id: string;
  user_name: string | null;
  started_at: Date;
  ended_at: Date | null;
  duration_ms: string | number | null;
  description: string | null;
  is_billable: boolean;
}

/**
 * The one entry this person has running, if any.
 *
 * **At most one is the rule the table was designed around** — its comment says
 * so, and `time_entries_running_idx` exists for exactly this lookup. The
 * database now holds the rule as a unique partial index rather than merely
 * hoping the service layer remembers it (D-094), so `LIMIT 1` here is a
 * statement about the data rather than a way of coping with it.
 *
 * The task join is a LEFT JOIN through `access_index` so an unreachable task
 * yields a running timer with no name attached, rather than no running timer.
 */
export async function runningEntryFor(
  userId: string,
  connection: Connection = pool(),
): Promise<RunningEntry | null> {
  const result = await connection.query<{
    id: string;
    task_id: string;
    started_at: Date;
    description: string | null;
    is_billable: boolean;
    task_key: string | null;
    task_name: string | null;
  }>(
    `SELECT e.id, e.task_id, e.started_at, e.description, e.is_billable,
            t.key AS task_key, t.name AS task_name
     FROM time_entries e
     LEFT JOIN tasks t
       ON t.id = e.task_id
      AND t.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM access_index ax
        WHERE ax.list_id = t.home_list_id AND ax.principal_id = e.user_id
      )
     WHERE e.user_id = $1 AND e.ended_at IS NULL
     ORDER BY e.started_at DESC
     LIMIT 1`,
    [userId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    taskId: row.task_id,
    startedAt: row.started_at.toISOString(),
    description: row.description,
    isBillable: row.is_billable,
    taskKey: row.task_key,
    taskName: row.task_name,
  };
}

/**
 * Every entry on a task, newest first.
 *
 * Not scoped here: the caller has already established that the viewer may see
 * the task, and tracked time is a fact about the task rather than about the
 * person who tracked it. Everyone who can open the task sees who spent what on
 * it — which is the point of tracking it against a shared thing.
 */
export async function loadTaskTime(
  taskId: string,
  connection: Connection = pool(),
): Promise<TimeEntryRecord[]> {
  const result = await connection.query<EntryRow>(
    `SELECT e.id, e.task_id, e.user_id, u.name AS user_name,
            e.started_at, e.ended_at, e.duration_ms, e.description, e.is_billable
     FROM time_entries e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.task_id = $1
     ORDER BY e.started_at DESC`,
    [taskId],
  );

  return result.rows.map(toRecord);
}

/**
 * Total tracked milliseconds on a task, running timers included.
 *
 * **Summed in SQL for what has stopped, and in JavaScript for what has not.**
 * `duration_ms` is denormalized precisely so the first half is a column sum
 * rather than a subtraction across every row (the schema's own reason). A
 * running entry has no duration to sum, so its length is measured against a
 * clock — and the clock has to be the one the caller is rendering with, or the
 * total would disagree with the timer ticking next to it.
 */
export function totalTrackedMs(entries: readonly TimeEntryRecord[], now = new Date()): number {
  return entries.reduce((total, entry) => total + recordDurationMs(entry, now), 0);
}

/** One entry's length, whether or not it has stopped. */
export function recordDurationMs(entry: TimeEntryRecord, now = new Date()): number {
  if (entry.endedAt === null) {
    return entryDurationMs(
      {
        startedAt: new Date(entry.startedAt),
        endedAt: null,
        description: entry.description,
        isBillable: entry.isBillable,
      },
      now,
    );
  }

  return entry.durationMs ?? 0;
}

export interface OwnedEntry {
  entryId: string;
  taskId: string;
  userId: string;
  /** What it holds now — the `from` half of the operation about to change it. */
  values: TimeEntryValues;
}

/**
 * An entry, if it belongs to this person.
 *
 * Null covers "no such entry" and "somebody else's" in the same answer, for the
 * reason every other refusal in this codebase does: told apart, they are an
 * oracle for which ids exist.
 *
 * **Ownership, not task access.** A person may always stop, correct and delete
 * their own time, whatever has happened to their grant on the task since
 * (D-095). Starting is the half that needs `edit`, because that is the half
 * that puts something new on somebody else's task.
 */
export async function ownTimeEntry(
  entryId: string,
  userId: string,
  connection: Connection = pool(),
): Promise<OwnedEntry | null> {
  if (!isId(entryId) || !isId(userId)) return null;

  const result = await connection.query<EntryRow>(
    `SELECT e.id, e.task_id, e.user_id, NULL AS user_name,
            e.started_at, e.ended_at, e.duration_ms, e.description, e.is_billable
     FROM time_entries e
     WHERE e.id = $1 AND e.user_id = $2`,
    [entryId, userId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    entryId: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    values: {
      startedAt: row.started_at,
      endedAt: row.ended_at,
      description: row.description,
      isBillable: row.is_billable,
    },
  };
}

function toRecord(row: EntryRow): TimeEntryRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    userName: row.user_name,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    // bigint comes back as a string from node-postgres unless it is told
    // otherwise, and a string that looks like a number sums as concatenation.
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    description: row.description,
    isBillable: row.is_billable,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isId(value: string): boolean {
  return UUID_RE.test(value);
}
