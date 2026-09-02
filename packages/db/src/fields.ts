import {
  type FieldCatalog,
  type FieldDefinition,
  type FieldPlacement,
  type FieldType,
  fieldValueColumn,
  fieldsForContainer,
  fieldsForTaskType,
  isFieldType,
  parseFieldConfig,
  parseFieldValue,
} from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";
import { type ConfigContext, ConfigError, inTransaction, logConfigChange, requireName } from "./config";
import { loadContainerTree } from "./containers";

/**
 * Loading the field catalog.
 *
 * @arbor/core cannot reach a database — that is what makes it testable — so
 * somebody has to hand it the fields a view references. This is that somebody.
 *
 * The catalog is loaded per workspace rather than per view: a workspace has
 * tens of fields, not thousands, and one small query is cheaper than working
 * out which subset a definition mentions and then discovering mid-compile that
 * the subset was wrong.
 */

interface FieldRow {
  id: string;
  type: string;
  type_config: Record<string, unknown> | null;
}

export class FieldNotFound extends Error {}

/**
 * A stored config that no longer parses is a real problem, not something to
 * paper over: the field's values are being read through a column chosen from
 * that config. Failing loudly here beats returning a catalog that silently
 * mistypes one field.
 */
function toDefinition(row: FieldRow): FieldDefinition {
  if (!isFieldType(row.type)) {
    throw new FieldNotFound(`Field ${row.id} has an unknown type: ${row.type}`);
  }
  const type: FieldType = row.type;
  return { id: row.id, type, typeConfig: parseFieldConfig(type, row.type_config ?? {}) };
}

/**
 * Every custom field in a workspace, ready to hand to the compiler.
 *
 * Archived fields are **included**. They are hidden from task forms, but their
 * values are still in the table and a saved view may still filter on one —
 * excluding them here would make archiving a field silently break every view
 * that mentions it, turning a reversible tidy-up into a data-shaped outage.
 */
export async function loadFieldCatalog(
  workspaceId: string,
  connection: Pool | PoolClient = pool(),
): Promise<FieldCatalog> {
  const result = await connection.query<FieldRow>(
    `SELECT id, type, type_config FROM fields WHERE workspace_id = $1 ORDER BY position`,
    [workspaceId],
  );

  return new Map(result.rows.map((row) => [row.id, toDefinition(row)]));
}

/** One field, for a write that names it. Throws rather than returning null. */
export async function loadField(
  fieldId: string,
  connection: Pool | PoolClient = pool(),
): Promise<FieldDefinition> {
  const result = await connection.query<FieldRow>(
    `SELECT id, type, type_config FROM fields WHERE id = $1 AND archived_at IS NULL`,
    [fieldId],
  );

  const row = result.rows[0];
  if (!row) throw new FieldNotFound(`Custom field not found or archived: ${fieldId}`);
  return toDefinition(row);
}

// --- the custom field service ----------------------------------------------

interface PlacementRow extends FieldRow {
  name: string;
  container_id: string | null;
  position: number;
  archived_at: Date | null;
  scope_task_type_ids: string[] | null;
}

function toPlacement(row: PlacementRow): FieldPlacement {
  return {
    ...toDefinition(row),
    name: row.name,
    containerId: row.container_id,
    position: row.position,
    scopeTaskTypeIds: row.scope_task_type_ids ?? [],
    archived: row.archived_at !== null,
  };
}

/** Every field in a workspace with its placement and task-type scopes. */
export async function loadFieldPlacements(
  workspaceId: string,
  connection: Pool | PoolClient = pool(),
): Promise<FieldPlacement[]> {
  const result = await connection.query<PlacementRow>(
    `SELECT f.id, f.type, f.type_config, f.name, f.container_id, f.position, f.archived_at,
            COALESCE(
              array_agg(fs.task_type_id) FILTER (WHERE fs.task_type_id IS NOT NULL),
              '{}'
            ) AS scope_task_type_ids
     FROM fields f
     LEFT JOIN field_scopes fs ON fs.field_id = f.id
     WHERE f.workspace_id = $1
     GROUP BY f.id
     ORDER BY f.position`,
    [workspaceId],
  );

  return result.rows.map(toPlacement);
}

/**
 * The fields a task in this container, of this type, actually shows.
 *
 * Both narrowing rules live in @arbor/core — inheritance down the tree and
 * scoping by task type — so the API, the task form, and eventually the mobile
 * client cannot each end up with a slightly different idea of which fields apply.
 */
export async function fieldsAvailableOn(
  workspaceId: string,
  containerId: string,
  taskTypeId: string | null = null,
  connection: Pool | PoolClient = pool(),
): Promise<FieldPlacement[]> {
  const [placements, containers] = await Promise.all([
    loadFieldPlacements(workspaceId, connection),
    loadContainerTree(workspaceId, connection),
  ]);

  return fieldsForTaskType(fieldsForContainer(containerId, containers, placements), taskTypeId);
}

export interface CreateFieldInput {
  workspaceId: string;
  /** Null defines it workspace-wide. */
  containerId?: string | null;
  name: string;
  type: FieldType;
  typeConfig?: unknown;
  description?: string | null;
  hideFromGuests?: boolean;
  /** Restrict to these task types. Empty means every type. */
  scopeTaskTypeIds?: string[];
}

export async function createField(
  input: CreateFieldInput,
  context: ConfigContext,
): Promise<FieldPlacement> {
  const name = requireName(input.name, "field");
  if (!isFieldType(input.type)) {
    throw new ConfigError(`Unknown field type: ${String(input.type)}`);
  }

  // Parsed before the transaction opens: a bad config is the caller's mistake,
  // and there is no point holding a connection to discover it.
  const typeConfig = parseFieldConfig(input.type, input.typeConfig ?? {});

  return inTransaction(context, async (client) => {
    const next = await client.query<{ position: number }>(
      `SELECT COALESCE(MAX(position) + 1, 0) AS position
       FROM fields WHERE workspace_id = $1 AND container_id IS NOT DISTINCT FROM $2`,
      [input.workspaceId, input.containerId ?? null],
    );

    const inserted = await client.query<PlacementRow>(
      `INSERT INTO fields
         (workspace_id, container_id, name, type, type_config, description, position, hide_from_guests)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, type, type_config, name, container_id, position, archived_at`,
      [
        input.workspaceId,
        input.containerId ?? null,
        name,
        input.type,
        JSON.stringify(typeConfig),
        input.description ?? null,
        next.rows[0]?.position ?? 0,
        input.hideFromGuests ?? false,
      ],
    );

    const row = inserted.rows[0];
    if (!row) throw new ConfigError("Field insert returned nothing");

    const scopes = input.scopeTaskTypeIds ?? [];
    if (scopes.length > 0) await writeScopes(client, row.id, scopes);

    await logConfigChange(client, {
      workspaceId: input.workspaceId,
      actorId: context.actorId,
      objectKind: "field",
      objectId: row.id,
      verb: "field.created",
      newValue: { name, type: input.type, containerId: input.containerId ?? null },
    });

    return toPlacement({ ...row, scope_task_type_ids: scopes });
  });
}

export interface UpdateFieldPatch {
  name?: string;
  typeConfig?: unknown;
  description?: string | null;
  hideFromGuests?: boolean;
}

/**
 * Edits everything about a field except its type.
 *
 * `typeConfig` is re-parsed against the existing type, so removing a dropdown
 * option that tasks still use is caught here rather than leaving those tasks
 * holding an id that no longer resolves to anything.
 */
export async function updateField(
  fieldId: string,
  patch: UpdateFieldPatch,
  context: ConfigContext,
): Promise<FieldPlacement> {
  return inTransaction(context, async (client) => {
    const current = await loadPlacementRow(client, fieldId);
    const definition = toDefinition(current);

    const typeConfig =
      patch.typeConfig === undefined
        ? definition.typeConfig
        : parseFieldConfig(definition.type, patch.typeConfig);

    if (patch.typeConfig !== undefined) {
      await assertNoOrphanedOptions(client, fieldId, definition.type, typeConfig);
    }

    const name = patch.name === undefined ? current.name : requireName(patch.name, "field");

    const updated = await client.query<PlacementRow>(
      `UPDATE fields
       SET name = $2,
           type_config = $3,
           description = COALESCE($4, description),
           hide_from_guests = COALESCE($5, hide_from_guests)
       WHERE id = $1
       RETURNING id, type, type_config, name, container_id, position, archived_at`,
      [
        fieldId,
        name,
        JSON.stringify(typeConfig),
        patch.description ?? null,
        patch.hideFromGuests ?? null,
      ],
    );

    const row = updated.rows[0];
    if (!row) throw new ConfigError(`Field not found: ${fieldId}`);

    await logConfigChange(client, {
      workspaceId: await workspaceOfField(client, fieldId),
      actorId: context.actorId,
      objectKind: "field",
      objectId: fieldId,
      verb: "field.updated",
      oldValue: { name: current.name, typeConfig: current.type_config },
      newValue: { name, typeConfig },
    });

    return toPlacement({ ...row, scope_task_type_ids: current.scope_task_type_ids });
  });
}

export interface FieldTypeChangePreview {
  convertible: number;
  unconvertible: number;
  /** A few examples, so a confirmation dialog can show what would be lost. */
  samples: { taskId: string; value: unknown; reason: string }[];
}

/**
 * What changing a field's type would do to the values already stored.
 *
 * This exists because the typed-EAV design (D-013) makes a type change a real
 * data migration, not a metadata edit: values live in the column their type
 * chose, so a `short_text` field becoming a `number` has to move every value
 * from `value_text` to `value_num` — and some of them will not convert.
 */
export async function previewFieldTypeChange(
  fieldId: string,
  nextType: FieldType,
  nextConfig: unknown = {},
  connection: Pool | PoolClient = pool(),
): Promise<FieldTypeChangePreview> {
  const current = await loadPlacementRow(connection, fieldId);
  const next: FieldDefinition = {
    id: fieldId,
    type: nextType,
    typeConfig: parseFieldConfig(nextType, nextConfig),
  };

  const values = await readAllValues(connection, fieldId, toDefinition(current));

  let convertible = 0;
  const samples: FieldTypeChangePreview["samples"] = [];

  for (const entry of values) {
    try {
      parseFieldValue(next, entry.value);
      convertible++;
    } catch (error) {
      if (samples.length < 5) {
        samples.push({
          taskId: entry.taskId,
          value: entry.value,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { convertible, unconvertible: values.length - convertible, samples };
}

/**
 * Changes a field's type, moving every stored value into the new column.
 *
 * Refuses when any value would be lost unless the caller passes
 * `discardUnconvertible` — the flag is the user's answer to a prompt, not a
 * default. Silently dropping the three values that failed to parse out of two
 * hundred is exactly the kind of quiet data loss nobody notices until a report
 * is wrong.
 */
export async function changeFieldType(
  fieldId: string,
  nextType: FieldType,
  nextConfig: unknown,
  options: { discardUnconvertible?: boolean },
  context: ConfigContext,
): Promise<{ converted: number; discarded: number }> {
  if (!isFieldType(nextType)) throw new ConfigError(`Unknown field type: ${String(nextType)}`);
  const parsedConfig = parseFieldConfig(nextType, nextConfig ?? {});

  return inTransaction(context, async (client) => {
    const current = await loadPlacementRow(client, fieldId);
    const before = toDefinition(current);

    if (before.type === nextType) {
      throw new ConfigError(`That field is already a ${nextType}`);
    }

    const next: FieldDefinition = { id: fieldId, type: nextType, typeConfig: parsedConfig };
    const oldColumn = fieldValueColumn(before);
    const newColumn = fieldValueColumn(next);
    const values = await readAllValues(client, fieldId, before);

    const converted: { taskId: string; value: unknown }[] = [];
    let discarded = 0;

    for (const entry of values) {
      try {
        converted.push({ taskId: entry.taskId, value: parseFieldValue(next, entry.value) });
      } catch {
        discarded++;
      }
    }

    if (discarded > 0 && !options.discardUnconvertible) {
      throw new ConfigError(
        `${discarded} of ${values.length} values cannot be read as a ${nextType}. ` +
          "Confirm the change to discard them, or export them first.",
      );
    }

    // Clear first, then write what converted: a row whose value did not convert
    // must end up empty rather than keeping a stale value in the old column
    // where nothing will ever read it again.
    await client.query(
      `UPDATE field_values SET ${oldColumn} = NULL, ${newColumn} = NULL, updated_at = now()
       WHERE field_id = $1`,
      [fieldId],
    );

    for (const entry of converted) {
      const param = newColumn === "value_json" ? JSON.stringify(entry.value) : entry.value;
      await client.query(
        `UPDATE field_values SET ${newColumn} = $3, updated_at = now()
         WHERE field_id = $1 AND task_id = $2`,
        [fieldId, entry.taskId, param],
      );
    }

    await client.query(`UPDATE fields SET type = $2, type_config = $3 WHERE id = $1`, [
      fieldId,
      nextType,
      JSON.stringify(parsedConfig),
    ]);

    await logConfigChange(client, {
      workspaceId: await workspaceOfField(client, fieldId),
      actorId: context.actorId,
      objectKind: "field",
      objectId: fieldId,
      verb: "field.type_changed",
      field: "type",
      oldValue: { type: before.type, values: values.length },
      newValue: { type: nextType, converted: converted.length, discarded },
    });

    return { converted: converted.length, discarded };
  });
}

/** Soft delete (D-015): the values survive, so restoring is a real restore. */
export async function archiveField(
  fieldId: string,
  archived: boolean,
  context: ConfigContext,
): Promise<void> {
  await inTransaction(context, async (client) => {
    const result = await client.query<{ workspace_id: string }>(
      `UPDATE fields SET archived_at = $2 WHERE id = $1 RETURNING workspace_id`,
      [fieldId, archived ? new Date() : null],
    );

    const row = result.rows[0];
    if (!row) throw new ConfigError(`Field not found: ${fieldId}`);

    await logConfigChange(client, {
      workspaceId: row.workspace_id,
      actorId: context.actorId,
      objectKind: "field",
      objectId: fieldId,
      verb: archived ? "field.archived" : "field.restored",
      field: "archived_at",
    });
  });
}

/** Replaces a field's task-type scopes. An empty list means "every type". */
export async function setFieldScopes(
  fieldId: string,
  taskTypeIds: readonly string[],
  context: ConfigContext,
): Promise<void> {
  await inTransaction(context, async (client) => {
    const current = await loadPlacementRow(client, fieldId);
    await client.query(`DELETE FROM field_scopes WHERE field_id = $1`, [fieldId]);
    if (taskTypeIds.length > 0) await writeScopes(client, fieldId, taskTypeIds);

    await logConfigChange(client, {
      workspaceId: await workspaceOfField(client, fieldId),
      actorId: context.actorId,
      objectKind: "field",
      objectId: fieldId,
      verb: "field.scopes_changed",
      oldValue: current.scope_task_type_ids ?? [],
      newValue: taskTypeIds,
    });
  });
}

// --- helpers ----------------------------------------------------------------

async function loadPlacementRow(
  client: Pool | PoolClient,
  fieldId: string,
): Promise<PlacementRow> {
  const result = await client.query<PlacementRow>(
    `SELECT f.id, f.type, f.type_config, f.name, f.container_id, f.position, f.archived_at,
            COALESCE(
              array_agg(fs.task_type_id) FILTER (WHERE fs.task_type_id IS NOT NULL),
              '{}'
            ) AS scope_task_type_ids
     FROM fields f
     LEFT JOIN field_scopes fs ON fs.field_id = f.id
     WHERE f.id = $1
     GROUP BY f.id`,
    [fieldId],
  );

  const row = result.rows[0];
  if (!row) throw new FieldNotFound(`Custom field not found: ${fieldId}`);
  return row;
}

async function workspaceOfField(client: Pool | PoolClient, fieldId: string): Promise<string> {
  const result = await client.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM fields WHERE id = $1`,
    [fieldId],
  );
  const row = result.rows[0];
  if (!row) throw new FieldNotFound(`Custom field not found: ${fieldId}`);
  return row.workspace_id;
}

async function writeScopes(
  client: PoolClient,
  fieldId: string,
  taskTypeIds: readonly string[],
): Promise<void> {
  await client.query(
    `INSERT INTO field_scopes (field_id, task_type_id)
     SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
    [fieldId, [...new Set(taskTypeIds)]],
  );
}

/** Every stored value for a field, read out of whichever column its type uses. */
async function readAllValues(
  client: Pool | PoolClient,
  fieldId: string,
  field: FieldDefinition,
): Promise<{ taskId: string; value: unknown }[]> {
  const column = fieldValueColumn(field);
  const result = await client.query<{ task_id: string; value: unknown }>(
    `SELECT task_id, ${column} AS value FROM field_values
     WHERE field_id = $1 AND ${column} IS NOT NULL`,
    [fieldId],
  );
  return result.rows.map((row) => ({ taskId: row.task_id, value: row.value }));
}

/**
 * Removing a dropdown option that tasks still hold would leave those values
 * pointing at nothing — the field would render blank and the task's history
 * would be the only record that anything was ever there.
 */
async function assertNoOrphanedOptions(
  client: Pool | PoolClient,
  fieldId: string,
  type: FieldType,
  config: unknown,
): Promise<void> {
  if (type !== "drop_down" && type !== "labels") return;

  const options = (config as { options?: { id: string }[] }).options ?? [];
  const keep = options.map((option) => option.id);

  const orphaned =
    type === "drop_down"
      ? await client.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM field_values
           WHERE field_id = $1 AND value_text IS NOT NULL AND NOT (value_text = ANY($2::text[]))`,
          [fieldId, keep],
        )
      : await client.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM field_values
           WHERE field_id = $1 AND value_json IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(value_json) AS held(id)
               WHERE NOT (held.id = ANY($2::text[]))
             )`,
          [fieldId, keep],
        );

  const count = Number(orphaned.rows[0]?.n ?? 0);
  if (count > 0) {
    throw new ConfigError(
      `${count} task${count === 1 ? "" : "s"} still use an option you are removing. ` +
        "Clear those values first, or keep the option.",
    );
  }
}
