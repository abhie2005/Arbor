"use server";

import { randomUUID } from "node:crypto";

import { type Operation, type TimeEntryValues, invertBatch, validateTimeEntry } from "@arbor/core";
import {
  applyOperations,
  ownTimeEntry,
  pool,
  requireTaskAccess,
  runningEntryFor,
} from "@arbor/db";
import { revalidatePath } from "next/cache";

import { requireUser } from "./auth";

/**
 * Time tracking actions.
 *
 * Same boundary rule as every other action file: build operations, hand them to
 * `applyOperations`, never write SQL. Tracked time is an operation (D-093), so
 * the activity row, undo and the live nudge arrive without this file doing
 * anything for any of them.
 *
 * **Two different authorizations, and the asymmetry is the point** (D-095).
 * Starting a timer puts something new on somebody else's task, so it takes
 * `edit` like every other write to that task. Stopping, correcting or deleting
 * an entry takes only that the entry is yours: a grant revoked mid-timer would
 * otherwise leave a running entry that nobody in the system is able to stop.
 */

/**
 * Starts the timer on a task, stopping whatever was running.
 *
 * **One batch, two operations.** The table allows at most one running entry per
 * person (D-094), and the pleasant way to honour that is to stop the old timer
 * rather than refuse the new one — which is also what the schema comment asked
 * for. Doing it as one batch means one undo entry: ⌘Z puts you back exactly
 * where you were, with the first timer running again and the second gone.
 *
 * The order matters and is the order the inverse depends on. Stopping comes
 * first, so there is never an instant with two running entries — and
 * `invertBatch` reverses it, so the undo removes the new entry before
 * restarting the old one, for the same reason.
 */
export async function startTimer(taskId: string): Promise<Operation[]> {
  const actor = await requireUser();
  await requireTaskAccess(taskId, actor.id, "edit");

  // ISO from here down: an operation is posted back by undo, so it has to be
  // JSON all the way through (D-097).
  const startedAt = new Date().toISOString();
  const running = await runningEntryFor(actor.id);

  const ops: Operation[] = [];

  if (running) {
    // Already running on this task: the click was a double-click, or a second
    // tab. Nothing to do, and nothing to put on the undo stack.
    if (running.taskId === taskId) return [];

    ops.push({
      kind: "setTimeEntry",
      entryId: running.id,
      taskId: running.taskId,
      from: {
        startedAt: running.startedAt,
        endedAt: null,
        description: running.description,
        isBillable: running.isBillable,
      },
      to: {
        startedAt: running.startedAt,
        endedAt: startedAt,
        description: running.description,
        isBillable: running.isBillable,
      },
    });
  }

  ops.push({
    kind: "createTimeEntry",
    entryId: randomUUID(),
    taskId,
    userId: actor.id,
    values: { startedAt, endedAt: null, description: null, isBillable: false },
  });

  await applyOperations(ops, { actorId: actor.id });
  revalidatePath("/", "layout");

  return invertBatch(ops);
}

/**
 * Stops whatever this person has running.
 *
 * Takes no task id: there is one running entry and the server knows which. A
 * client naming the task would be a client that can be wrong about it — the
 * shell's timer readout is as old as its last render, and the timer it is
 * showing may have been stopped in another tab.
 */
export async function stopTimer(): Promise<Operation[]> {
  const actor = await requireUser();

  const running = await runningEntryFor(actor.id);
  if (!running) return [];

  const from: TimeEntryValues = {
    startedAt: running.startedAt,
    endedAt: null,
    description: running.description,
    isBillable: running.isBillable,
  };

  const op: Operation = {
    kind: "setTimeEntry",
    entryId: running.id,
    taskId: running.taskId,
    from,
    to: { ...from, endedAt: new Date().toISOString() },
  };

  await applyOperations([op], { actorId: actor.id });
  revalidatePath("/", "layout");

  return [{ ...op, from: op.to, to: op.from }];
}

/**
 * Logs time that was spent without a timer running.
 *
 * Minutes rather than milliseconds at this boundary, because a form asks a
 * person for minutes and converting in the browser puts the arithmetic on the
 * side of the wire that cannot be checked. The end is *now* and the start is
 * derived backwards from it: "I spent 45 minutes on this" is a claim about a
 * duration, and inventing a start time for it is the only way to store it in a
 * table whose rows are two instants.
 */
export async function logTime(
  taskId: string,
  minutes: number,
  description: string,
  isBillable: boolean,
): Promise<Operation[]> {
  const actor = await requireUser();
  await requireTaskAccess(taskId, actor.id, "edit");

  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("Enter how many minutes to log");
  }

  const endedAt = new Date();
  const values: TimeEntryValues = {
    startedAt: new Date(endedAt.getTime() - Math.round(minutes) * 60_000).toISOString(),
    endedAt: endedAt.toISOString(),
    description: description.trim() || null,
    isBillable,
  };

  // Refused here as well as in the executor, so the person typing gets the
  // sentence rather than a rejected transaction.
  validateTimeEntry(values);

  const op: Operation = {
    kind: "createTimeEntry",
    entryId: randomUUID(),
    taskId,
    userId: actor.id,
    values,
  };

  await applyOperations([op], { actorId: actor.id });
  revalidatePath("/", "layout");

  return invertBatch([op]);
}

/**
 * Corrects an entry: its length, its note, whether it is billable.
 *
 * A running entry keeps running — `endedAt` is not something this touches,
 * because the only two things that legitimately set it are stopping and undo,
 * and a form that could clear it would be a second way to start a timer that
 * skips the one-running-entry batch.
 */
export async function updateTimeEntry(
  entryId: string,
  minutes: number | null,
  description: string,
  isBillable: boolean,
): Promise<Operation[]> {
  const actor = await requireUser();

  const owned = await ownTimeEntry(entryId, actor.id);
  if (!owned) throw new Error("That time entry no longer exists");

  const to: TimeEntryValues = {
    ...owned.values,
    description: description.trim() || null,
    isBillable,
  };

  if (minutes !== null) {
    if (owned.values.endedAt === null) {
      throw new Error("Stop the timer before changing how long it ran");
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error("A time entry has to be longer than nothing");
    }

    // The end is held and the start moves. Holding the *start* would move an
    // entry into the future the moment somebody lengthened one that had just
    // finished, and "when did you stop" is the half people remember.
    to.startedAt = new Date(
      new Date(owned.values.endedAt).getTime() - Math.round(minutes) * 60_000,
    ).toISOString();
  }

  validateTimeEntry(to);

  const op: Operation = {
    kind: "setTimeEntry",
    entryId,
    taskId: owned.taskId,
    from: owned.values,
    to,
  };

  await applyOperations([op], { actorId: actor.id });
  revalidatePath("/", "layout");

  return [{ ...op, from: to, to: owned.values }];
}

/** Removes an entry. Hard, and undoable, because the row rides on the operation. */
export async function deleteTimeEntry(entryId: string): Promise<Operation[]> {
  const actor = await requireUser();

  const owned = await ownTimeEntry(entryId, actor.id);
  if (!owned) throw new Error("That time entry no longer exists");

  const op: Operation = {
    kind: "deleteTimeEntry",
    entryId,
    taskId: owned.taskId,
    userId: owned.userId,
    values: owned.values,
  };

  await applyOperations([op], { actorId: actor.id });
  revalidatePath("/", "layout");

  return invertBatch([op]);
}

/**
 * The task-level estimate.
 *
 * **`tasks.time_estimate_ms` is the estimate, and `task_estimates` stays
 * empty** (D-096). The per-assignee table exists and its column comment says
 * what it is for; nothing writes to it, because making it authoritative would
 * turn a column the `setField` operation already writes into a derived one —
 * quietly making that operation, its undo and its activity row describe
 * something that is no longer true.
 */
export async function setTimeEstimate(
  taskId: string,
  minutes: number | null,
): Promise<Operation[]> {
  const actor = await requireUser();
  await requireTaskAccess(taskId, actor.id, "edit");

  if (minutes !== null && (!Number.isFinite(minutes) || minutes < 0)) {
    throw new Error("An estimate cannot be negative");
  }

  const current = await pool().query<{ time_estimate_ms: string | null }>(
    `SELECT time_estimate_ms FROM tasks WHERE id = $1`,
    [taskId],
  );

  // bigint arrives as a string from node-postgres, and a string in `from` would
  // make the inverse write a string back into a numeric column.
  const raw = current.rows[0]?.time_estimate_ms ?? null;
  const from = raw === null ? null : Number(raw);
  const to = minutes === null || minutes === 0 ? null : Math.round(minutes) * 60_000;

  const op: Operation = { kind: "setField", taskId, field: "timeEstimateMs", from, to };

  await applyOperations([op], { actorId: actor.id });
  revalidatePath("/", "layout");

  return [{ ...op, from: to, to: from }];
}
