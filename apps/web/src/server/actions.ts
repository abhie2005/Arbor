"use server";

import { randomUUID } from "node:crypto";

import { type Operation, positionBetween } from "@arbor/core";
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

/** Applies an inverse batch produced by one of the actions above. */
export async function undo(ops: Operation[]): Promise<void> {
  if (ops.length === 0) return;
  const actor = await requireUser();
  await applyOperations(ops, { actorId: actor.id });
  revalidatePath("/");
}

/** Development only — see D-034. */
export async function switchUser(userId: string): Promise<void> {
  if (!devAuthEnabled()) throw new Error("The user switcher is disabled outside development");

  const store = await cookies();
  store.set(DEV_USER_COOKIE, userId, { httpOnly: true, sameSite: "lax", path: "/" });
  revalidatePath("/");
}
