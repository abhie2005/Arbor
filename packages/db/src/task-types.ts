import type { Operation } from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";
import { type ConfigContext, ConfigError, inTransaction, logConfigChange, requireName } from "./config";
import { applyOperations } from "./mutations";

/**
 * Task types.
 *
 * A type is a small object with a large consequence: it decides which custom
 * fields a task renders (see `fieldsForTaskType` in @arbor/core), so every
 * operation here is really an operation on what people see when they open a task.
 */

export interface TaskType {
  id: string;
  name: string;
  icon: string | null;
  isDefault: boolean;
  taskCount: number;
}

interface TaskTypeRow {
  id: string;
  workspace_id: string;
  name: string;
  icon: string | null;
  is_default: boolean;
  task_count?: string;
}

export async function listTaskTypes(
  workspaceId: string,
  connection: Pool | PoolClient = pool(),
): Promise<TaskType[]> {
  const result = await connection.query<TaskTypeRow>(
    `SELECT tt.id, tt.workspace_id, tt.name, tt.icon, tt.is_default,
            COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL) AS task_count
     FROM task_types tt
     LEFT JOIN tasks t ON t.task_type_id = tt.id
     WHERE tt.workspace_id = $1
     GROUP BY tt.id
     ORDER BY tt.is_default DESC, tt.name`,
    [workspaceId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    icon: row.icon,
    isDefault: row.is_default,
    taskCount: Number(row.task_count ?? 0),
  }));
}

export async function createTaskType(
  input: { workspaceId: string; name: string; icon?: string | null; isDefault?: boolean },
  context: ConfigContext,
): Promise<TaskType> {
  const name = requireName(input.name, "task type");

  return inTransaction(context, async (client) => {
    if (input.isDefault) await clearDefault(client, input.workspaceId);

    const result = await client.query<TaskTypeRow>(
      `INSERT INTO task_types (workspace_id, name, icon, is_default)
       VALUES ($1, $2, $3, $4)
       RETURNING id, workspace_id, name, icon, is_default`,
      [input.workspaceId, name, input.icon ?? null, input.isDefault ?? false],
    );

    const row = result.rows[0];
    if (!row) throw new ConfigError("Task type insert returned nothing");

    await logConfigChange(client, {
      workspaceId: input.workspaceId,
      actorId: context.actorId,
      objectKind: "task_type",
      objectId: row.id,
      verb: "task_type.created",
      newValue: { name, isDefault: row.is_default },
    });

    return { id: row.id, name: row.name, icon: row.icon, isDefault: row.is_default, taskCount: 0 };
  });
}

export async function updateTaskType(
  taskTypeId: string,
  patch: { name?: string; icon?: string | null },
  context: ConfigContext,
): Promise<void> {
  await inTransaction(context, async (client) => {
    const current = await loadTaskTypeRow(client, taskTypeId);
    const name = patch.name === undefined ? current.name : requireName(patch.name, "task type");

    await client.query(`UPDATE task_types SET name = $2, icon = $3 WHERE id = $1`, [
      taskTypeId,
      name,
      patch.icon === undefined ? current.icon : patch.icon,
    ]);

    await logConfigChange(client, {
      workspaceId: current.workspace_id,
      actorId: context.actorId,
      objectKind: "task_type",
      objectId: taskTypeId,
      verb: "task_type.updated",
      oldValue: { name: current.name, icon: current.icon },
      newValue: { name, icon: patch.icon ?? current.icon },
    });
  });
}

/**
 * Exactly one default per workspace, enforced by clearing the old one in the
 * same transaction. Two defaults is not a state anything downstream can read —
 * "which type does a new task get" would have two answers.
 */
export async function setDefaultTaskType(
  taskTypeId: string,
  context: ConfigContext,
): Promise<void> {
  await inTransaction(context, async (client) => {
    const current = await loadTaskTypeRow(client, taskTypeId);
    await clearDefault(client, current.workspace_id);
    await client.query(`UPDATE task_types SET is_default = true WHERE id = $1`, [taskTypeId]);

    await logConfigChange(client, {
      workspaceId: current.workspace_id,
      actorId: context.actorId,
      objectKind: "task_type",
      objectId: taskTypeId,
      verb: "task_type.set_default",
      field: "is_default",
      newValue: true,
    });
  });
}

/**
 * Deletes a type, moving its tasks to a replacement — or to no type at all.
 *
 * Unlike a status (D-043), "no type" is a legal state for a task: it simply
 * shows the unscoped fields. So `replacementId` may be null here, where a
 * status deletion requires a target. The move is still expressed as operations
 * so it is undoable and appears in each task's history — deleting a type
 * changes which fields those tasks display, which is not a change to make
 * silently.
 */
export async function deleteTaskType(
  taskTypeId: string,
  replacementId: string | null,
  context: ConfigContext,
): Promise<{ movedTasks: number }> {
  return inTransaction(context, async (client) => {
    const current = await loadTaskTypeRow(client, taskTypeId);

    if (replacementId === taskTypeId) {
      throw new ConfigError("A task type cannot be replaced by itself");
    }

    if (replacementId) {
      const replacement = await loadTaskTypeRow(client, replacementId);
      if (replacement.workspace_id !== current.workspace_id) {
        throw new ConfigError("The replacement type belongs to another workspace");
      }
    }

    const affected = await client.query<{ id: string }>(
      `SELECT id FROM tasks WHERE task_type_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [taskTypeId],
    );

    const operations: Operation[] = affected.rows.map((row) => ({
      kind: "setField",
      taskId: row.id,
      field: "taskTypeId",
      from: taskTypeId,
      to: replacementId,
    }));

    await applyOperations(operations, { actorId: context.actorId, client });
    await client.query(`DELETE FROM task_types WHERE id = $1`, [taskTypeId]);

    // A workspace with no default type would leave "which type does a new task
    // get" unanswered, so the deletion promotes another rather than leaving it.
    if (current.is_default) {
      await client.query(
        `UPDATE task_types SET is_default = true
         WHERE id = (SELECT id FROM task_types WHERE workspace_id = $1 ORDER BY name LIMIT 1)`,
        [current.workspace_id],
      );
    }

    await logConfigChange(client, {
      workspaceId: current.workspace_id,
      actorId: context.actorId,
      objectKind: "task_type",
      objectId: taskTypeId,
      verb: "task_type.deleted",
      oldValue: { name: current.name },
      newValue: { movedTo: replacementId, movedTasks: operations.length },
    });

    return { movedTasks: operations.length };
  });
}

async function clearDefault(client: PoolClient, workspaceId: string): Promise<void> {
  await client.query(
    `UPDATE task_types SET is_default = false WHERE workspace_id = $1 AND is_default = true`,
    [workspaceId],
  );
}

async function loadTaskTypeRow(
  client: Pool | PoolClient,
  taskTypeId: string,
): Promise<TaskTypeRow> {
  const result = await client.query<TaskTypeRow>(
    `SELECT id, workspace_id, name, icon, is_default FROM task_types WHERE id = $1`,
    [taskTypeId],
  );
  const row = result.rows[0];
  if (!row) throw new ConfigError(`Task type not found: ${taskTypeId}`);
  return row;
}
