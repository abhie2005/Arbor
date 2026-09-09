import type { Pool, PoolClient } from "pg";

import { pool } from "./client";

/**
 * The activity log, read.
 *
 * `activity` has been written to since Phase 2 — every operation puts a row in
 * it, which is what makes undo and the notification fan-out possible — and
 * until now nothing has ever read one back. This is its first reader, and the
 * shape it wants is the plainest one: what happened to *this* task, newest
 * first.
 *
 * **Nearly everything is shown, including the dull rows.** The inbox filters
 * out anything that is not news, because an inbox is a queue of things worth
 * your attention; a history answers "what happened to this thing", and one with
 * the boring parts removed cannot settle an argument about what happened. So a
 * watcher joining is here, and so is a field nobody looks at.
 *
 * **Reordering is the one exception.** `position` is where a task sits among
 * its siblings — it is not a property of the task, it changes whenever anything
 * near it moves, and a drag on a board writes one alongside the status change
 * that actually happened. Two lines reading "changed position" between every
 * real entry is how a history stops being read at all.
 */

export interface HistoryEntry {
  id: string;
  /** e.g. "task.status_id_changed", "comment.added". */
  verb: string;
  /** The column, the relation, or the id of the thing the verb is about. */
  field: string | null;
  from: unknown;
  to: unknown;
  at: string;
  actorId: string | null;
  /** Null when the actor's account is gone — the row outlives the person. */
  actorName: string | null;
}

/**
 * One task's history, scoped to someone who may read it.
 *
 * The `access_index` join is the same one every other read uses, and it is here
 * rather than borrowed from the page that calls it: a loader that is only safe
 * when its caller checked first is a loader that will eventually be called by
 * something that did not (D-080).
 */
export async function loadTaskHistory(
  taskId: string,
  viewerId: string,
  limit = 60,
  connection: Pool | PoolClient = pool(),
): Promise<HistoryEntry[]> {
  const result = await connection.query<{
    id: string;
    verb: string;
    field: string | null;
    old_value: unknown;
    new_value: unknown;
    at: Date;
    actor_id: string | null;
    actor_name: string | null;
  }>(
    `SELECT a.id::text AS id, a.verb, a.field, a.old_value, a.new_value, a.at,
            a.actor_id, u.name AS actor_name
     FROM activity a
     JOIN tasks t ON t.id = a.object_id AND t.deleted_at IS NULL
     JOIN access_index ax
       ON ax.list_id = t.home_list_id AND ax.principal_id = $2
     LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.object_kind = 'task' AND a.object_id = $1
       AND a.verb <> 'task.position_changed'
     ORDER BY a.at DESC, a.id DESC
     LIMIT $3`,
    [taskId, viewerId, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    verb: row.verb,
    field: row.field,
    from: row.old_value,
    to: row.new_value,
    at: row.at.toISOString(),
    actorId: row.actor_id,
    actorName: row.actor_name,
  }));
}
