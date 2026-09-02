import {
  type ContainerNode,
  type StatusDefinition,
  type StatusGroup,
  type StatusSetDefinition,
  assertUsableStatusSet,
  canDeleteStatus,
  containersAffectedBy,
  indexById,
  isStatusGroup,
  planStatusDeletion,
  reorderStatuses,
  resolveStatusSet,
  statusTemplate,
} from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";
import {
  type ConfigContext,
  ConfigError,
  inTransaction,
  logConfigChange,
  requireColor,
  requireName,
} from "./config";
import { applyOperations } from "./mutations";

/**
 * The status set service.
 *
 * Reads assemble the shapes @arbor/core resolves against; writes validate
 * through it before touching a row. The rule that keeps this honest: **no
 * status write happens without re-checking the whole set afterwards**. Every
 * individual edit looks harmless — rename one, recolour one, change one's group
 * — and the damage always comes from what the set looks like once it lands.
 */

const DEFAULT_STATUS_COLOR = "#6B7686";

interface StatusRow {
  id: string;
  status_set_id: string;
  name: string;
  group: string;
  color: string;
  position: number;
}

interface SetRow {
  id: string;
  workspace_id: string;
  container_id: string | null;
  name: string;
  is_template: boolean;
}

function toStatus(row: StatusRow): StatusDefinition {
  if (!isStatusGroup(row.group)) {
    throw new ConfigError(`Status ${row.id} has an unknown group: ${row.group}`);
  }
  return {
    id: row.id,
    name: row.name,
    group: row.group,
    color: row.color,
    position: row.position,
  };
}

/** Every container in a workspace, in the shape @arbor/core walks. */
export async function loadContainerTree(
  workspaceId: string,
  connection: Pool | PoolClient = pool(),
): Promise<Map<string, ContainerNode>> {
  const result = await connection.query<{
    id: string;
    parent_id: string | null;
    kind: ContainerNode["kind"];
    name: string;
    is_private: boolean;
  }>(
    `SELECT id, parent_id, kind, name, is_private
     FROM containers
     WHERE workspace_id = $1 AND archived_at IS NULL`,
    [workspaceId],
  );

  return indexById(
    result.rows.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      kind: row.kind,
      name: row.name,
      isPrivate: row.is_private,
    })),
  );
}

/** Every status set in a workspace, statuses included, ordered by position. */
export async function loadStatusSets(
  workspaceId: string,
  connection: Pool | PoolClient = pool(),
): Promise<StatusSetDefinition[]> {
  const sets = await connection.query<SetRow>(
    `SELECT id, workspace_id, container_id, name, is_template
     FROM status_sets WHERE workspace_id = $1 ORDER BY name`,
    [workspaceId],
  );

  if (sets.rows.length === 0) return [];

  const statuses = await connection.query<StatusRow>(
    `SELECT id, status_set_id, name, "group", color, position
     FROM statuses WHERE status_set_id = ANY($1) ORDER BY position`,
    [sets.rows.map((row) => row.id)],
  );

  const bySet = new Map<string, StatusDefinition[]>();
  for (const row of statuses.rows) {
    bySet.set(row.status_set_id, [...(bySet.get(row.status_set_id) ?? []), toStatus(row)]);
  }

  return sets.rows.map((row) => ({
    id: row.id,
    name: row.name,
    containerId: row.container_id,
    isTemplate: row.is_template,
    statuses: bySet.get(row.id) ?? [],
  }));
}

export interface ResolvedStatusSet {
  set: StatusSetDefinition;
  /** Where the set came from, for "inherited from Engineering". */
  sourceName: string;
  /** True when the container defines the set rather than inheriting it. */
  isOwn: boolean;
}

/**
 * The set a container's tasks actually use.
 *
 * The walk itself lives in @arbor/core (`resolveStatusSet`) so it is the same
 * one every other inherited setting uses. This function's only job is loading
 * the two maps it needs.
 */
export async function resolveStatusSetFor(
  workspaceId: string,
  containerId: string,
  connection: Pool | PoolClient = pool(),
): Promise<ResolvedStatusSet> {
  const [containers, sets] = await Promise.all([
    loadContainerTree(workspaceId, connection),
    loadStatusSets(workspaceId, connection),
  ]);

  const attached = new Map(
    sets.filter((s) => s.containerId && !s.isTemplate).map((s) => [s.containerId!, s]),
  );
  const workspaceDefault = sets.find((s) => s.containerId === null && !s.isTemplate);

  const { set, source } = resolveStatusSet(containerId, containers, attached, workspaceDefault);

  return {
    set,
    sourceName: source === "workspace" ? "Workspace default" : source.name,
    isOwn: source !== "workspace" && source.id === containerId,
  };
}

/** Lists and folders that would change if a set were attached to a container. */
export async function previewStatusSetAttachment(
  workspaceId: string,
  containerId: string,
  connection: Pool | PoolClient = pool(),
): Promise<{ affectedContainerIds: string[]; affectedContainerNames: string[] }> {
  const [containers, sets] = await Promise.all([
    loadContainerTree(workspaceId, connection),
    loadStatusSets(workspaceId, connection),
  ]);

  const attached = new Map(
    sets
      .filter((s) => s.containerId && !s.isTemplate && s.containerId !== containerId)
      .map((s) => [s.containerId!, s]),
  );

  const ids = containersAffectedBy(containerId, containers, attached);
  return {
    affectedContainerIds: ids,
    affectedContainerNames: ids.map((id) => containers.get(id)?.name ?? id),
  };
}

export interface CreateStatusSetInput {
  workspaceId: string;
  /** Null attaches nothing: a workspace default, or a template when `isTemplate`. */
  containerId?: string | null;
  name: string;
  /** Seed the statuses from a template. Ignored when `statuses` is supplied. */
  templateKey?: string;
  statuses?: Omit<StatusDefinition, "id">[];
  isTemplate?: boolean;
}

export async function createStatusSet(
  input: CreateStatusSetInput,
  context: ConfigContext,
): Promise<StatusSetDefinition> {
  const name = requireName(input.name, "status set");

  const seed =
    input.statuses ??
    (input.templateKey ? statusTemplate(input.templateKey).statuses : undefined);

  if (!seed || seed.length === 0) {
    throw new ConfigError("A new status set needs either a template or a list of statuses");
  }

  // Validate before writing anything. The ids are placeholders — the rules are
  // about names and groups, neither of which the database assigns.
  assertUsableStatusSet(seed.map((status, i) => ({ ...status, id: `seed-${i}` })));

  return inTransaction(context, async (client) => {
    const set = await client.query<SetRow>(
      `INSERT INTO status_sets (workspace_id, container_id, name, is_template)
       VALUES ($1, $2, $3, $4)
       RETURNING id, workspace_id, container_id, name, is_template`,
      [input.workspaceId, input.containerId ?? null, name, input.isTemplate ?? false],
    );

    const row = set.rows[0];
    if (!row) throw new ConfigError("Status set insert returned nothing");

    const inserted = await client.query<StatusRow>(
      `INSERT INTO statuses (status_set_id, name, "group", color, position)
       SELECT $1, s.name, s."group"::status_group, s.color, s.position
       FROM jsonb_to_recordset($2::jsonb)
         AS s(name text, "group" text, color text, position int)
       RETURNING id, status_set_id, name, "group", color, position`,
      [
        row.id,
        JSON.stringify(
          seed.map((status, index) => ({
            name: requireName(status.name, "status"),
            group: status.group,
            color: requireColor(status.color, DEFAULT_STATUS_COLOR),
            position: index,
          })),
        ),
      ],
    );

    await logConfigChange(client, {
      workspaceId: input.workspaceId,
      actorId: context.actorId,
      objectKind: "status_set",
      objectId: row.id,
      verb: "status_set.created",
      newValue: { name, statuses: seed.length, containerId: input.containerId ?? null },
    });

    return {
      id: row.id,
      name: row.name,
      containerId: row.container_id,
      isTemplate: row.is_template,
      statuses: inserted.rows.map(toStatus).sort((a, b) => a.position - b.position),
    };
  });
}

/**
 * Points a container at a set, or clears the attachment so it inherits again.
 *
 * A set belongs to one container: attaching set A to a folder that already has
 * set B detaches B rather than creating an ambiguous double attachment, which
 * `resolveStatusSet` would have to break arbitrarily.
 */
export async function attachStatusSet(
  setId: string,
  containerId: string | null,
  context: ConfigContext,
): Promise<void> {
  await inTransaction(context, async (client) => {
    const set = await loadSetRow(client, setId);

    if (set.is_template && containerId) {
      throw new ConfigError(
        "A template is a starting point, not a live set — create a set from it instead of attaching it",
      );
    }

    if (containerId) {
      await client.query(
        `UPDATE status_sets SET container_id = NULL
         WHERE container_id = $1 AND workspace_id = $2 AND id <> $3`,
        [containerId, set.workspace_id, setId],
      );
    }

    await client.query(`UPDATE status_sets SET container_id = $2 WHERE id = $1`, [
      setId,
      containerId,
    ]);

    await logConfigChange(client, {
      workspaceId: set.workspace_id,
      actorId: context.actorId,
      objectKind: "status_set",
      objectId: setId,
      verb: containerId ? "status_set.attached" : "status_set.detached",
      field: "container_id",
      oldValue: set.container_id,
      newValue: containerId,
    });
  });
}

export interface AddStatusInput {
  name: string;
  group: StatusGroup;
  color?: string;
  /** Where in the order it lands. Appended when omitted. */
  index?: number;
}

export async function addStatus(
  setId: string,
  input: AddStatusInput,
  context: ConfigContext,
): Promise<StatusDefinition> {
  const name = requireName(input.name, "status");
  if (!isStatusGroup(input.group)) {
    throw new ConfigError(`Unknown status group: ${String(input.group)}`);
  }

  return inTransaction(context, async (client) => {
    const set = await loadSetRow(client, setId);
    const existing = await loadStatusesForUpdate(client, setId);

    const inserted = await client.query<StatusRow>(
      `INSERT INTO statuses (status_set_id, name, "group", color, position)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, status_set_id, name, "group", color, position`,
      [
        setId,
        name,
        input.group,
        requireColor(input.color, DEFAULT_STATUS_COLOR),
        existing.length,
      ],
    );

    const row = inserted.rows[0];
    if (!row) throw new ConfigError("Status insert returned nothing");
    const status = toStatus(row);

    assertUsableStatusSet([...existing, status]);

    if (input.index !== undefined) {
      await writePositions(client, reorderStatuses([...existing, status], status.id, input.index));
    }

    await logConfigChange(client, {
      workspaceId: set.workspace_id,
      actorId: context.actorId,
      objectKind: "status",
      objectId: status.id,
      verb: "status.created",
      newValue: { name: status.name, group: status.group, setId },
    });

    return status;
  });
}

export interface UpdateStatusPatch {
  name?: string;
  group?: StatusGroup;
  color?: string;
}

/**
 * Renames, recolours, or regroups one status.
 *
 * The group is the interesting one. Moving the only `done` status to `active`
 * is a one-word edit that makes every completion percentage in the workspace
 * zero — so the whole set is re-validated before the transaction commits, and
 * the edit is refused rather than accepted and reported later.
 */
export async function updateStatus(
  statusId: string,
  patch: UpdateStatusPatch,
  context: ConfigContext,
): Promise<StatusDefinition> {
  return inTransaction(context, async (client) => {
    const current = await loadStatusRow(client, statusId);
    const set = await loadSetRow(client, current.status_set_id);
    const siblings = await loadStatusesForUpdate(client, current.status_set_id);

    if (patch.group !== undefined && !isStatusGroup(patch.group)) {
      throw new ConfigError(`Unknown status group: ${String(patch.group)}`);
    }

    const next: StatusDefinition = {
      ...toStatus(current),
      ...(patch.name !== undefined ? { name: requireName(patch.name, "status") } : {}),
      ...(patch.group !== undefined ? { group: patch.group } : {}),
      ...(patch.color !== undefined
        ? { color: requireColor(patch.color, DEFAULT_STATUS_COLOR) }
        : {}),
    };

    assertUsableStatusSet(siblings.map((s) => (s.id === statusId ? next : s)));

    await client.query(
      `UPDATE statuses SET name = $2, "group" = $3, color = $4 WHERE id = $1`,
      [statusId, next.name, next.group, next.color],
    );

    await logConfigChange(client, {
      workspaceId: set.workspace_id,
      actorId: context.actorId,
      objectKind: "status",
      objectId: statusId,
      verb: "status.updated",
      oldValue: { name: current.name, group: current.group, color: current.color },
      newValue: { name: next.name, group: next.group, color: next.color },
    });

    return next;
  });
}

export async function moveStatus(
  statusId: string,
  toIndex: number,
  context: ConfigContext,
): Promise<StatusDefinition[]> {
  return inTransaction(context, async (client) => {
    const current = await loadStatusRow(client, statusId);
    const set = await loadSetRow(client, current.status_set_id);
    const statuses = await loadStatusesForUpdate(client, current.status_set_id);

    const reordered = reorderStatuses(statuses, statusId, toIndex);
    await writePositions(client, reordered);

    await logConfigChange(client, {
      workspaceId: set.workspace_id,
      actorId: context.actorId,
      objectKind: "status",
      objectId: statusId,
      verb: "status.moved",
      field: "position",
      oldValue: current.position,
      newValue: toIndex,
    });

    return reordered;
  });
}

export interface StatusUsage {
  statusId: string;
  taskCount: number;
  /** Statuses a migration could send those tasks to. */
  replacements: StatusDefinition[];
  blockedReason: string | null;
}

/**
 * What deleting a status would cost — the prompt, before the decision.
 *
 * Deleting a status without asking is not an option here: the foreign key is
 * `ON DELETE SET NULL`, so every task that used it would silently lose its
 * status and vanish from a grouped view. Answering "12 tasks are in Done, where
 * should they go?" is the whole feature.
 */
export async function statusUsage(
  statusId: string,
  connection: Pool | PoolClient = pool(),
): Promise<StatusUsage> {
  const status = await loadStatusRow(connection, statusId);
  // Read-only: no FOR UPDATE. This runs to render a confirmation dialog, and
  // holding row locks while a human decides is how a settings screen becomes
  // an outage.
  const siblings = await loadStatuses(connection, status.status_set_id);

  const count = await connection.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM tasks WHERE status_id = $1 AND deleted_at IS NULL`,
    [statusId],
  );

  const verdict = canDeleteStatus(siblings, statusId);

  return {
    statusId,
    taskCount: Number(count.rows[0]?.n ?? 0),
    replacements: siblings.filter((s) => s.id !== statusId),
    blockedReason: verdict.ok ? null : verdict.reason,
  };
}

/**
 * Deletes a status, moving every task that used it first.
 *
 * The move goes through `applyOperations` rather than a bulk UPDATE, so each
 * task's change lands in its own history and the whole migration is undoable —
 * the same machinery as clicking a status dot. Both halves share one
 * transaction, because a migration that committed while the delete failed would
 * leave tasks moved for no reason.
 */
export async function deleteStatus(
  statusId: string,
  replacementId: string,
  context: ConfigContext,
): Promise<{ movedTasks: number }> {
  return inTransaction(context, async (client) => {
    const status = await loadStatusRow(client, statusId);
    const set = await loadSetRow(client, status.status_set_id);
    const siblings = await loadStatusesForUpdate(client, status.status_set_id);

    const affected = await client.query<{ id: string }>(
      `SELECT id FROM tasks WHERE status_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [statusId],
    );

    const plan = planStatusDeletion(
      siblings,
      statusId,
      replacementId,
      affected.rows.map((row) => row.id),
    );

    await applyOperations(plan.operations, { actorId: context.actorId, client });

    await client.query(`DELETE FROM statuses WHERE id = $1`, [statusId]);
    await writePositions(
      client,
      siblings
        .filter((s) => s.id !== statusId)
        .map((status, index) => ({ ...status, position: index })),
    );

    await logConfigChange(client, {
      workspaceId: set.workspace_id,
      actorId: context.actorId,
      objectKind: "status",
      objectId: statusId,
      verb: "status.deleted",
      oldValue: { name: status.name, group: status.group },
      newValue: { movedTo: replacementId, movedTasks: plan.movedTasks },
    });

    return { movedTasks: plan.movedTasks };
  });
}

// --- row loaders ------------------------------------------------------------

async function loadSetRow(client: Pool | PoolClient, setId: string): Promise<SetRow> {
  const result = await client.query<SetRow>(
    `SELECT id, workspace_id, container_id, name, is_template FROM status_sets WHERE id = $1`,
    [setId],
  );
  const row = result.rows[0];
  if (!row) throw new ConfigError(`Status set not found: ${setId}`);
  return row;
}

async function loadStatusRow(client: Pool | PoolClient, statusId: string): Promise<StatusRow> {
  const result = await client.query<StatusRow>(
    `SELECT id, status_set_id, name, "group", color, position FROM statuses WHERE id = $1`,
    [statusId],
  );
  const row = result.rows[0];
  if (!row) throw new ConfigError(`Status not found: ${statusId}`);
  return row;
}

async function loadStatuses(
  client: Pool | PoolClient,
  setId: string,
): Promise<StatusDefinition[]> {
  const result = await client.query<StatusRow>(
    `SELECT id, status_set_id, name, "group", color, position
     FROM statuses WHERE status_set_id = $1 ORDER BY position`,
    [setId],
  );
  return result.rows.map(toStatus);
}

/**
 * `FOR UPDATE` because two people editing the same set concurrently would
 * otherwise each validate against a set the other is about to change, and both
 * could pass while the result of the pair does not.
 */
async function loadStatusesForUpdate(
  client: Pool | PoolClient,
  setId: string,
): Promise<StatusDefinition[]> {
  const result = await client.query<StatusRow>(
    `SELECT id, status_set_id, name, "group", color, position
     FROM statuses WHERE status_set_id = $1 ORDER BY position
     FOR UPDATE`,
    [setId],
  );
  return result.rows.map(toStatus);
}

async function writePositions(
  client: PoolClient,
  statuses: readonly StatusDefinition[],
): Promise<void> {
  if (statuses.length === 0) return;

  // One statement rather than a loop: positions are a set, and renumbering them
  // row by row leaves the table transiently violating its own ordering.
  await client.query(
    `UPDATE statuses AS s SET position = v.position
     FROM jsonb_to_recordset($1::jsonb) AS v(id uuid, position int)
     WHERE s.id = v.id`,
    [JSON.stringify(statuses.map((s) => ({ id: s.id, position: s.position })))],
  );
}
