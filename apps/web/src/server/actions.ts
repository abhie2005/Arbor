"use server";

import { randomUUID } from "node:crypto";

import { type Operation, invertBatch, positionBetween, startOfUtcDay } from "@arbor/core";
import {
  applyOperations,
  pool,
  requireListAccess,
  requireTaskAccess,
  requireTasksAccess,
  resolveStatusSetFor,
} from "@arbor/db";
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
 *
 * **Every one authorizes before it writes** (D-080). `requireUser` establishes
 * who is asking; `requireTaskAccess` establishes whether they may. Until the
 * task detail page there was no way to name a task you could not already see,
 * so the second was missing and nothing demonstrated it. A URL carrying an id
 * is the thing that made it demonstrable.
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
  await requireTaskAccess(taskId, actor.id, "edit");

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

/**
 * Sets a status directly, rather than advancing to the next one.
 *
 * Cycling is right for a list row: one control's worth of space, and one click
 * has to mean something. A detail page has room to show the whole set, and
 * picking is what someone who opened a task expects. Both produce the same
 * `setField` operation, so undo, the activity row and the inverse are shared —
 * only the gesture differs.
 *
 * The status is checked against the set the task's list resolves (D-014), not
 * merely against `statuses`, or a task could be moved into a status belonging
 * to another space's set and then disappear from its own board.
 */
export async function setTaskStatus(taskId: string, statusId: string): Promise<Operation[]> {
  const actor = await requireUser();
  const access = await requireTaskAccess(taskId, actor.id, "edit");

  const current = await pool().query<{ status_id: string | null }>(
    `SELECT status_id FROM tasks WHERE id = $1`,
    [taskId],
  );

  const resolved = await resolveStatusSetFor(access.workspaceId, access.homeListId);
  if (!resolved.set.statuses.some((status) => status.id === statusId)) {
    throw new Error("That status does not belong to this list's status set");
  }

  const from = current.rows[0]?.status_id ?? null;
  if (from === statusId) return [];

  const op: Operation = { kind: "setField", taskId, field: "statusId", from, to: statusId };

  await applyOperations([op], { actorId: actor.id });
  revalidatePath("/", "layout");

  return [{ ...op, from: statusId, to: from }];
}

export async function setPriority(taskId: string, priority: number | null): Promise<Operation[]> {
  const actor = await requireUser();
  await requireTaskAccess(taskId, actor.id, "edit");

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
  await requireTaskAccess(taskId, actor.id, "edit");

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
  await requireTaskAccess(taskId, actor.id, "edit");

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
  // A container, not a task — an unchecked create is how a row lands inside a
  // private list its author cannot read.
  await requireListAccess(listId, actor.id, "edit");

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
  await requireTaskAccess(taskId, actor.id, "edit");

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
  await requireTaskAccess(taskId, actor.id, "edit");

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

/**
 * Adds or removes an assignee or a watcher — the detail panel's people controls.
 *
 * `RelationOp` has been in the operation union since Phase 3 and the executor
 * has handled it since; nothing had ever called it, because no screen could
 * assign anyone. So this action is four lines and inherits an activity row and
 * a working undo, which is the whole argument for the operation layer.
 *
 * The relation is closed to these two rather than taken from the caller: `tag`
 * is the third member of the union, and a control that assigns people has no
 * business being able to name it.
 */
export async function setTaskRelation(
  taskId: string,
  relation: "assignee" | "watcher",
  targetId: string,
  present: boolean,
): Promise<Operation[]> {
  const actor = await requireUser();
  await requireTaskAccess(taskId, actor.id, "edit");

  if (relation !== "assignee" && relation !== "watcher") {
    throw new Error(`Not a people relation: ${String(relation)}`);
  }

  const op: Operation = {
    kind: present ? "addRelation" : "removeRelation",
    taskId,
    relation,
    targetId,
  };

  await applyOperations([op], { actorId: actor.id });
  revalidatePath("/", "layout");

  return invertBatch([op]);
}

/**
 * Changes a task's type.
 *
 * Worth its own action rather than folding into a generic setter because the
 * type decides *which custom fields the task has*, so the panel has to
 * re-render its whole field section afterwards rather than one control.
 */
export async function setTaskType(
  taskId: string,
  taskTypeId: string | null,
): Promise<Operation[]> {
  const actor = await requireUser();
  await requireTaskAccess(taskId, actor.id, "edit");

  const current = await pool().query<{ task_type_id: string | null }>(
    `SELECT task_type_id FROM tasks WHERE id = $1`,
    [taskId],
  );

  const from = current.rows[0]?.task_type_id ?? null;
  const op: Operation = { kind: "setField", taskId, field: "taskTypeId", from, to: taskTypeId };

  await applyOperations([op], { actorId: actor.id });
  revalidatePath("/", "layout");

  return [{ ...op, from: taskTypeId, to: from }];
}

/**
 * Writes a custom field value.
 *
 * **The action does not decide what the value is.** `setCustomField` reaches an
 * executor that loads the field, picks the typed column from its type, and runs
 * the value through `parseFieldValue` — which is what refuses a derived field
 * and what stops a number landing in `value_text` where no filter would find it
 * again (D-042). Validating here as well would be a second opinion, and the one
 * that matters is the one nearest the write.
 *
 * The previous value is read here because the inverse has to carry it (D-036),
 * and only the server knows it. One column of the row holds it — the rest are
 * null by construction — so coalescing across them reads the one that is set.
 */
export async function setCustomFieldValue(
  taskId: string,
  fieldId: string,
  value: unknown,
): Promise<Operation[]> {
  const actor = await requireUser();
  await requireTaskAccess(taskId, actor.id, "edit");

  const current = await pool().query<{
    value_text: string | null;
    value_num: string | null;
    value_date: Date | null;
    value_bool: boolean | null;
    value_json: unknown;
  }>(
    `SELECT value_text, value_num, value_date, value_bool, value_json
     FROM field_values WHERE task_id = $1 AND field_id = $2`,
    [taskId, fieldId],
  );

  const stored = current.rows[0];
  const from =
    stored === undefined
      ? null
      : (stored.value_text ??
        (stored.value_num === null ? null : Number(stored.value_num)) ??
        (stored.value_date === null ? null : stored.value_date.toISOString()) ??
        stored.value_bool ??
        stored.value_json ??
        null);

  const op: Operation = { kind: "setCustomField", taskId, fieldId, from, to: value };

  await applyOperations([op], { actorId: actor.id });
  revalidatePath("/", "layout");

  return [{ ...op, from: value, to: from }];
}

/**
 * Applies an inverse batch produced by one of the actions above.
 *
 * **The widest write in the app**, and so the one that most needed a check: the
 * operations arrive from the client, and every other action derives its target
 * from a task the caller already named. A batch is authorized whole and refused
 * whole — applying the reachable half of an undo would half-restore a task and
 * tell the caller which of the ids were real.
 */
export async function undo(ops: Operation[]): Promise<void> {
  if (ops.length === 0) return;
  const actor = await requireUser();
  await requireTasksAccess(
    ops.map((op) => op.taskId),
    actor.id,
    "edit",
  );

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
