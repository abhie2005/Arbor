"use server";

import { randomUUID } from "node:crypto";

import { type Operation, invertBatch, positionBetween, startOfUtcDay } from "@arbor/core";
import { applyOperations, pool } from "@arbor/db";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { DEV_USER_COOKIE, devAuthEnabled, requireUser } from "./auth";

/**
 * Server actions are the API boundary.
 *
 * Each one builds `Operation` values and hands them to `applyOperations`. They
 * never write SQL themselves — that keeps the activity log complete by
 * construction, and it means undo works for free, since every action's effect
 * is already expressed as invertible operations.
 */

/**
 * Advances a task to the next status in its set, wrapping at the end.
 *
 * Returns the inverse so the client can push it onto the undo stack. The server
 * decides what the inverse is, because only the server knows the previous value
 * — trusting the client's idea of `from` would let a stale tab undo to a value
 * that was never there.
 */
export async function cycleStatus(taskId: string): Promise<Operation[]> {
  const actor = await requireUser();
  const current = await pool().query<{ status_id: string; status_set_id: string }>(
    `SELECT t.status_id, s.status_set_id
     FROM tasks t JOIN statuses s ON s.id = t.status_id
     WHERE t.id = $1`,
    [taskId],
  );

  const row = current.rows[0];
  if (!row) throw new Error("Task has no status to advance");

  const next = await pool().query<{ id: string }>(
    `WITH ordered AS (
       SELECT id, position, LEAD(id) OVER (ORDER BY position) AS next_id,
              FIRST_VALUE(id) OVER (ORDER BY position) AS first_id
       FROM statuses WHERE status_set_id = $1
     )
     SELECT COALESCE(next_id, first_id) AS id FROM ordered WHERE id = $2`,
    [row.status_set_id, row.status_id],
  );

  const nextId = next.rows[0]?.id;
  if (!nextId || nextId === row.status_id) return [];

  const op: Operation = {
    kind: "setField",
    taskId,
    field: "statusId",
    from: row.status_id,
    to: nextId,
  };

  await applyOperations([op], { actorId: actor.id });
  revalidatePath("/");

  return [{ ...op, from: nextId, to: row.status_id }];
}

export async function setPriority(taskId: string, priority: number | null): Promise<Operation[]> {
  const actor = await requireUser();
  const current = await pool().query<{ priority: number | null }>(
    `SELECT priority FROM tasks WHERE id = $1`,
    [taskId],
  );

  const from = current.rows[0]?.priority ?? null;
  const op: Operation = { kind: "setField", taskId, field: "priority", from, to: priority };

  await applyOperations([op], { actorId: actor.id });
  revalidatePath("/");

  return [{ ...op, from: priority, to: from }];
}

export async function renameTask(taskId: string, name: string): Promise<Operation[]> {
  const actor = await requireUser();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("A task needs a name");

  const current = await pool().query<{ name: string }>(`SELECT name FROM tasks WHERE id = $1`, [
    taskId,
  ]);

  const from = current.rows[0]?.name ?? "";
  const op: Operation = { kind: "setField", taskId, field: "name", from, to: trimmed };

  await applyOperations([op], { actorId: actor.id });
  revalidatePath("/");

  return [{ ...op, from: trimmed, to: from }];
}

export async function archiveTask(taskId: string): Promise<Operation[]> {
  const actor = await requireUser();
  await applyOperations([{ kind: "archiveTask", taskId }], { actorId: actor.id });
  revalidatePath("/");
  return [{ kind: "restoreTask", taskId }];
}

/**
 * Creates a task at the end of a status group.
 *
 * The position is computed from the current last sibling rather than from a
 * count, so two people creating at once get distinct positions instead of
 * colliding (D-012).
 */
export async function createTask(
  listId: string,
  name: string,
  statusId: string | null,
): Promise<Operation[]> {
  const actor = await requireUser();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("A task needs a name");

  const context = await pool().query<{
    space_id: string;
    folder_id: string | null;
    last_position: string | null;
  }>(
    `SELECT
       COALESCE(sp.id, c.id) AS space_id,
       CASE WHEN f.kind = 'folder' THEN f.id ELSE NULL END AS folder_id,
       (SELECT MAX(position) FROM task_lists WHERE list_id = c.id) AS last_position
     FROM containers c
     LEFT JOIN containers f  ON f.id = c.parent_id
     LEFT JOIN containers sp ON sp.id = f.parent_id
     WHERE c.id = $1`,
    [listId],
  );

  const ctx = context.rows[0];
  if (!ctx) throw new Error("List not found");

  const taskId = randomUUID();

  await applyOperations([
    {
      kind: "createTask",
      taskId,
      listId,
      values: {
        name: trimmed,
        spaceId: ctx.space_id,
        folderId: ctx.folder_id,
        statusId,
        position: positionBetween(ctx.last_position, null),
      },
    },
  ], { actorId: actor.id });

  revalidatePath("/");
  return [{ kind: "archiveTask", taskId }];
}

/**
 * Moves a task to a position in a status column — one drag on the board.
 *
 * **Two fields, one batch.** A drag changes status *and* order, and undoing it
 * has to reverse both together: putting the card back in the right column but
 * the wrong place is not an undo. `applyOperations` runs the batch in a single
 * transaction, and the inverse comes back as a single stack entry, so one ⌘Z
 * undoes one drag.
 *
 * The caller names the neighbours it dropped between rather than an index. An
 * index is a statement about a list the client rendered a moment ago; the
 * neighbours are rows, and `positionBetween` turns them into a key that lands
 * between them no matter what else moved in the meantime (D-012). One row is
 * written, not a renumbered column.
 */
export async function moveTask(
  taskId: string,
  statusId: string,
  beforeTaskId: string | null,
  afterTaskId: string | null,
): Promise<Operation[]> {
  const actor = await requireUser();

  const current = await pool().query<{ status_id: string | null; position: string }>(
    `SELECT status_id, position FROM tasks WHERE id = $1 AND deleted_at IS NULL`,
    [taskId],
  );

  const task = current.rows[0];
  if (!task) throw new Error("That task no longer exists");

  // Read the neighbours' positions now rather than trusting values the client
  // has been holding since its last render.
  const neighbours = await pool().query<{ id: string; position: string }>(
    `SELECT id, position FROM tasks WHERE id = ANY($1)`,
    [[beforeTaskId, afterTaskId].filter(Boolean)],
  );

  const positionOf = (id: string | null) =>
    id ? (neighbours.rows.find((row) => row.id === id)?.position ?? null) : null;

  const applied: Operation[] = [];

  if (statusId !== task.status_id) {
    applied.push({
      kind: "setField",
      taskId,
      field: "statusId",
      from: task.status_id,
      to: statusId,
    });
  }

  const position = positionBetween(positionOf(beforeTaskId), positionOf(afterTaskId));
  if (position !== task.position) {
    applied.push({
      kind: "setField",
      taskId,
      field: "position",
      from: task.position,
      to: position,
    });
  }

  if (applied.length === 0) return [];

  await applyOperations(applied, { actorId: actor.id });
  revalidatePath("/");
  revalidatePath("/board");

  // Inverted once, here, by the side that knows the previous values (D-036) —
  // and the client stores what it is handed without inverting again (D-049).
  return invertBatch(applied);
}

/**
 * Moves a task to a day — one drag on the calendar.
 *
 * Whichever date the calendar is showing is the one that moves, so a calendar
 * on start dates reschedules start dates. The set of fields is closed here
 * rather than taken from the caller: `setField` will write any column in its
 * map, and a date argument arriving from a drag has no business being able to
 * name `position`.
 *
 * **The day is stored at midnight UTC** and the task is marked as carrying no
 * time (D-067). Dropping a task on the 4th means the 4th, and a task that had
 * a time loses it — which is the honest reading of dragging something onto a
 * square that represents a whole day.
 */
export async function setTaskDate(
  taskId: string,
  field: "dueAt" | "startAt",
  day: string | null,
): Promise<Operation[]> {
  const actor = await requireUser();

  if (field !== "dueAt" && field !== "startAt") {
    throw new Error(`A calendar may only move a due or start date, not ${String(field)}`);
  }
  if (day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`Not a day: ${day}`);
  }

  const column = field === "dueAt" ? "due_at" : "start_at";
  const flag = field === "dueAt" ? "due_has_time" : "start_has_time";

  const current = await pool().query<{ value: Date | null; has_time: boolean }>(
    `SELECT ${column} AS value, ${flag} AS has_time FROM tasks WHERE id = $1 AND deleted_at IS NULL`,
    [taskId],
  );

  const task = current.rows[0];
  if (!task) throw new Error("That task no longer exists");

  const from = task.value === null ? null : task.value.toISOString();
  const to = day === null ? null : startOfUtcDay(day).toISOString();
  if (from === to && !task.has_time) return [];

  const op: Operation = { kind: "setField", taskId, field, from, to };
  await applyOperations([op], { actorId: actor.id });

  // The flag is not an invertible operation — it is a property of the value,
  // and undo restores the value. Written directly, alongside, so a restored
  // timed date does not come back as a day.
  await pool().query(`UPDATE tasks SET ${flag} = $1 WHERE id = $2`, [false, taskId]);

  revalidatePath("/");
  revalidatePath("/calendar");

  return [{ ...op, from: to, to: from }];
}

/** Applies an inverse batch produced by one of the actions above. */
export async function undo(ops: Operation[]): Promise<void> {
  if (ops.length === 0) return;
  const actor = await requireUser();
  await applyOperations(ops, { actorId: actor.id });
  revalidatePath("/");
  revalidatePath("/board");
  revalidatePath("/calendar");
}

/** Development only — see D-034. */
export async function switchUser(userId: string): Promise<void> {
  if (!devAuthEnabled()) throw new Error("The user switcher is disabled outside development");

  const store = await cookies();
  store.set(DEV_USER_COOKIE, userId, { httpOnly: true, sameSite: "lax", path: "/" });
  revalidatePath("/");
}
