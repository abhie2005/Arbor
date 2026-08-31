import { type Operation, activityVerb, isNoop } from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";

/**
 * Applies operations and records them.
 *
 * The whole batch runs in **one transaction**, so a bulk edit either lands
 * completely or not at all — a half-applied selection is impossible to
 * communicate to a user and impossible to undo correctly.
 *
 * Every operation writes both its table change and its activity row here, in
 * the same place. Assembling log rows at each call site is how field changes
 * silently stop being recorded once there are thirty call sites.
 *
 * This lives in the data layer rather than the web app on purpose: the worker
 * applies operations too, because that is exactly what an automation action is.
 * The caller supplies the actor — the web app from its session, the worker from
 * the automation — so identity stays the concern of whoever has it.
 */

/**
 * Columns an operation may write, mapped to their SQL names.
 *
 * Closed map, same reasoning as the view compiler (D-018): `Operation.field` is
 * ultimately shaped by client input, so it must never reach a query as text.
 */
const FIELD_COLUMNS = {
  name: "name",
  statusId: "status_id",
  priority: "priority",
  dueAt: "due_at",
  startAt: "start_at",
  points: "points",
  timeEstimateMs: "time_estimate_ms",
  parentTaskId: "parent_task_id",
  homeListId: "home_list_id",
  taskTypeId: "task_type_id",
  position: "position",
} as const;

const RELATION_TABLES = {
  assignee: { table: "task_assignees", column: "user_id" },
  watcher: { table: "task_watchers", column: "user_id" },
  tag: { table: "task_tags", column: "tag_id" },
} as const;

export class MutationRejected extends Error {}

export interface ApplyResult {
  applied: number;
  skipped: number;
}

export interface ApplyContext {
  /** Who is making the change. Required — see the note on logActivity. */
  actorId: string;
  connection?: Pool;
}

export async function applyOperations(
  ops: readonly Operation[],
  context: ApplyContext,
): Promise<ApplyResult> {
  if (!context.actorId) {
    // An activity log with a null author is worse than no log, because it still
    // looks trustworthy.
    throw new MutationRejected("applyOperations requires an actorId");
  }

  // Filter no-ops before opening a transaction: clicking the status a task
  // already has should not write a row or broadcast a delta.
  const meaningful = ops.filter((op) => !isNoop(op));
  if (meaningful.length === 0) return { applied: 0, skipped: ops.length };

  const client = await (context.connection ?? pool()).connect();

  try {
    await client.query("BEGIN");

    for (const op of meaningful) {
      await applyOne(client, op, context.actorId);
    }

    await client.query("COMMIT");
    return { applied: meaningful.length, skipped: ops.length - meaningful.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function applyOne(client: PoolClient, op: Operation, actorId: string): Promise<void> {
  switch (op.kind) {
    case "setField": {
      const column = FIELD_COLUMNS[op.field];
      if (!column) throw new MutationRejected(`Field is not writable: ${op.field}`);

      // Completion is derived, not set by the client: moving a task into a
      // `done` status stamps completed_at, moving it out clears it. Leaving
      // this to callers means the timestamp drifts out of sync with status.
      const completion =
        op.field === "statusId"
          ? `, completed_at = CASE
               WHEN (SELECT "group" FROM statuses WHERE id = $2) IN ('done','closed')
                 THEN COALESCE(tasks.completed_at, now())
               ELSE NULL
             END`
          : "";

      const result = await client.query(
        `UPDATE tasks
         SET ${column} = $2, updated_at = now()${completion}
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING workspace_id, home_list_id`,
        [op.taskId, op.to],
      );

      const row = requireRow(result.rows[0], op.taskId);
      await logActivity(client, {
        op,
        actorId,
        workspaceId: row.workspace_id,
        listId: row.home_list_id,
        field: column,
        oldValue: op.from,
        newValue: op.to,
      });
      return;
    }

    case "setCustomField": {
      const column = customFieldColumn(op.to ?? op.from);

      // Upsert: a task may have no row for this field yet.
      await client.query(
        `INSERT INTO field_values (task_id, field_id, ${column}, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (task_id, field_id)
         DO UPDATE SET ${column} = EXCLUDED.${column}, updated_at = now()`,
        [op.taskId, op.fieldId, op.to],
      );

      const meta = await taskMeta(client, op.taskId);
      await logActivity(client, {
        op,
        actorId,
        workspaceId: meta.workspace_id,
        listId: meta.home_list_id,
        field: op.fieldId,
        oldValue: op.from,
        newValue: op.to,
      });
      return;
    }

    case "addRelation":
    case "removeRelation": {
      const target = RELATION_TABLES[op.relation];
      if (!target) throw new MutationRejected(`Unknown relation: ${op.relation}`);

      if (op.kind === "addRelation") {
        // Idempotent: adding an assignee twice is a no-op, not an error. The
        // client may retry an optimistic write.
        await client.query(
          `INSERT INTO ${target.table} (task_id, ${target.column})
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [op.taskId, op.targetId],
        );
      } else {
        await client.query(
          `DELETE FROM ${target.table} WHERE task_id = $1 AND ${target.column} = $2`,
          [op.taskId, op.targetId],
        );
      }

      const meta = await taskMeta(client, op.taskId);
      await logActivity(client, {
        op,
        actorId,
        workspaceId: meta.workspace_id,
        listId: meta.home_list_id,
        field: op.relation,
        oldValue: op.kind === "removeRelation" ? op.targetId : null,
        newValue: op.kind === "addRelation" ? op.targetId : null,
      });
      return;
    }

    case "createTask": {
      const v = op.values as Record<string, unknown>;

      const result = await client.query(
        `INSERT INTO tasks
           (id, workspace_id, home_list_id, space_id, folder_id, name,
            status_id, priority, position, created_by)
         SELECT $1, c.workspace_id, c.id,
                $3::uuid, $4::uuid, $5, $6::uuid, $7::int, $8, $9
         FROM containers c WHERE c.id = $2
         RETURNING workspace_id, home_list_id`,
        [
          op.taskId,
          op.listId,
          v.spaceId,
          v.folderId ?? null,
          v.name,
          v.statusId ?? null,
          v.priority ?? null,
          v.position,
          actorId,
        ],
      );

      const row = requireRow(result.rows[0], op.taskId);

      // Home-list membership is a row in task_lists too (D-010), written in the
      // same transaction so the two placements can never disagree.
      await client.query(
        `INSERT INTO task_lists (task_id, list_id, is_home, position)
         VALUES ($1, $2, true, $3)`,
        [op.taskId, op.listId, v.position],
      );

      await logActivity(client, {
        op,
        actorId,
        workspaceId: row.workspace_id,
        listId: row.home_list_id,
        field: null,
        oldValue: null,
        newValue: { name: v.name },
      });
      return;
    }

    case "archiveTask":
    case "restoreTask": {
      const result = await client.query(
        `UPDATE tasks SET archived_at = $2, updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING workspace_id, home_list_id`,
        [op.taskId, op.kind === "archiveTask" ? new Date() : null],
      );

      const row = requireRow(result.rows[0], op.taskId);
      await logActivity(client, {
        op,
        actorId,
        workspaceId: row.workspace_id,
        listId: row.home_list_id,
        field: "archived_at",
        oldValue: null,
        newValue: op.kind === "archiveTask",
      });
      return;
    }

    default: {
      const exhaustive: never = op;
      throw new MutationRejected(`Unhandled operation: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Same typed-column choice the view compiler makes when filtering (D-013). */
function customFieldColumn(sample: unknown): string {
  if (typeof sample === "number") return "value_num";
  if (typeof sample === "boolean") return "value_bool";
  if (sample instanceof Date) return "value_date";
  if (sample !== null && typeof sample === "object") return "value_json";
  return "value_text";
}

interface TaskMeta {
  workspace_id: string;
  home_list_id: string;
}

function requireRow(row: TaskMeta | undefined, taskId: string): TaskMeta {
  if (!row) {
    throw new MutationRejected(`Task not found or already deleted: ${taskId}`);
  }
  return row;
}

async function taskMeta(client: PoolClient, taskId: string): Promise<TaskMeta> {
  const result = await client.query<TaskMeta>(
    `SELECT workspace_id, home_list_id FROM tasks WHERE id = $1 AND deleted_at IS NULL`,
    [taskId],
  );
  return requireRow(result.rows[0], taskId);
}

interface LogArgs {
  op: Operation;
  actorId: string;
  workspaceId: string;
  listId: string;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
}

async function logActivity(client: PoolClient, args: LogArgs): Promise<void> {
  await client.query(
    `INSERT INTO activity
       (workspace_id, actor_id, object_kind, object_id, verb, field, old_value, new_value, list_id)
     VALUES ($1, $2, 'task', $3, $4, $5, $6, $7, $8)`,
    [
      args.workspaceId,
      args.actorId,
      args.op.taskId,
      activityVerb(args.op),
      args.field,
      args.oldValue === undefined ? null : JSON.stringify(args.oldValue),
      args.newValue === undefined ? null : JSON.stringify(args.newValue),
      args.listId,
    ],
  );
}
