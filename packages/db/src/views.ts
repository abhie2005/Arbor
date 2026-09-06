import {
  DEFAULT_VIEW_DEFINITION,
  type ViewDefinition,
  type ViewType,
  compileViewQuery,
  positionBetween,
  validateColumns,
} from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";
import { type ConfigContext, ConfigError, inTransaction, logConfigChange, requireName } from "./config";
import { loadFieldCatalog } from "./fields";

/**
 * Saved views.
 *
 * A view is a name, a renderer, and a definition. The definition is the same
 * object the compiler consumes (D-017), so saving a view is saving a query —
 * which is why this service refuses to save one that will not compile.
 *
 * **Validating on write, not on read.** A definition that throws at compile
 * time is a view that cannot open, and the person who finds out is whoever
 * clicks it next — possibly a teammate, possibly weeks later. Compiling it here
 * costs microseconds (the compiler is pure; nothing touches the database) and
 * moves the failure to the person who caused it, while they still have the
 * context to fix it.
 */

const VIEW_KINDS = new Set<string>([
  "list",
  "board",
  "table",
  "calendar",
  "gantt",
  "timeline",
  "workload",
  "map",
  "activity",
  "form",
  "doc",
]);

export interface SavedView {
  id: string;
  name: string;
  type: ViewType;
  definition: ViewDefinition;
  parentId: string | null;
  ownerId: string | null;
  position: string;
  isDefault: boolean;
}

interface ViewRow {
  id: string;
  workspace_id: string;
  name: string;
  type: string;
  definition: ViewDefinition;
  parent_id: string | null;
  parent_kind: string | null;
  owner_id: string | null;
  position: string;
  is_default: boolean;
}

function toView(row: ViewRow): SavedView {
  return {
    id: row.id,
    name: row.name,
    type: row.type as ViewType,
    definition: row.definition,
    parentId: row.parent_id,
    ownerId: row.owner_id,
    position: row.position,
    isDefault: row.is_default,
  };
}

/**
 * Views on a container: everything shared, plus this viewer's personal ones.
 *
 * Someone else's personal view is deliberately invisible rather than merely
 * unlisted — "personal" that shows up in a teammate's tab strip is not personal.
 */
export async function listViews(
  workspaceId: string,
  parentId: string,
  viewerId: string,
  connection: Pool | PoolClient = pool(),
): Promise<SavedView[]> {
  const result = await connection.query<ViewRow>(
    `SELECT id, workspace_id, name, type, definition, parent_id, parent_kind,
            owner_id, position, is_default
     FROM views
     WHERE workspace_id = $1 AND parent_id = $2
       AND (owner_id IS NULL OR owner_id = $3)
     ORDER BY position`,
    [workspaceId, parentId, viewerId],
  );
  return result.rows.map(toView);
}

export async function loadViewById(
  viewId: string,
  connection: Pool | PoolClient = pool(),
): Promise<SavedView> {
  const result = await connection.query<ViewRow>(
    `SELECT id, workspace_id, name, type, definition, parent_id, parent_kind,
            owner_id, position, is_default
     FROM views WHERE id = $1`,
    [viewId],
  );
  const row = result.rows[0];
  if (!row) throw new ConfigError(`View not found: ${viewId}`);
  return toView(row);
}

/**
 * Compiles the definition and throws if it will not.
 *
 * The viewer id is a placeholder: compilation is pure and never runs the query,
 * so who would be running it does not change whether it is valid SQL.
 */
export async function assertViewCompiles(
  workspaceId: string,
  parentId: string | null,
  definition: ViewDefinition,
  connection: Pool | PoolClient = pool(),
): Promise<void> {
  const fields = await loadFieldCatalog(workspaceId, connection);

  try {
    compileViewQuery({
      workspaceId,
      viewerId: "00000000-0000-4000-8000-000000000000",
      scope: parentId ? { kind: "list", id: parentId } : { kind: "everything" },
      definition,
      fields,
    });
    // Columns are not part of the query, so compiling cannot vouch for them.
    // Validated here rather than nowhere: this is the write path, which is the
    // end where a broken column is still someone's mistake to fix (D-060).
    validateColumns(definition.columns, fields);
  } catch (error) {
    throw new ConfigError(
      `That view cannot be saved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface CreateViewInput {
  workspaceId: string;
  parentId: string;
  parentKind?: "space" | "folder" | "list";
  type: ViewType;
  name: string;
  definition?: ViewDefinition;
  /** Set to make it personal to one user; null shares it with the container. */
  ownerId?: string | null;
}

export async function createView(
  input: CreateViewInput,
  context: ConfigContext,
): Promise<SavedView> {
  const name = requireName(input.name, "view");
  if (!VIEW_KINDS.has(input.type)) {
    throw new ConfigError(`Unknown view type: ${String(input.type)}`);
  }

  const definition = input.definition ?? DEFAULT_VIEW_DEFINITION;
  await assertViewCompiles(input.workspaceId, input.parentId, definition);

  return inTransaction(context, async (client) => {
    const last = await client.query<{ position: string | null }>(
      `SELECT MAX(position) AS position FROM views WHERE parent_id = $1`,
      [input.parentId],
    );

    const result = await client.query<ViewRow>(
      `INSERT INTO views
         (workspace_id, parent_id, parent_kind, type, name, definition,
          owner_id, position, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, workspace_id, name, type, definition, parent_id, parent_kind,
                 owner_id, position, is_default`,
      [
        input.workspaceId,
        input.parentId,
        input.parentKind ?? "list",
        input.type,
        name,
        JSON.stringify(definition),
        input.ownerId ?? null,
        positionBetween(last.rows[0]?.position ?? null, null),
        context.actorId,
      ],
    );

    const row = result.rows[0];
    if (!row) throw new ConfigError("View insert returned nothing");

    await logConfigChange(client, {
      workspaceId: input.workspaceId,
      actorId: context.actorId,
      objectKind: "view",
      objectId: row.id,
      verb: "view.created",
      newValue: { name, type: input.type, personal: input.ownerId != null },
    });

    return toView(row);
  });
}

export async function renameView(
  viewId: string,
  name: string,
  context: ConfigContext,
): Promise<void> {
  const trimmed = requireName(name, "view");

  await inTransaction(context, async (client) => {
    const current = await loadRow(client, viewId);
    await client.query(`UPDATE views SET name = $2, updated_at = now() WHERE id = $1`, [
      viewId,
      trimmed,
    ]);

    await logConfigChange(client, {
      workspaceId: current.workspace_id,
      actorId: context.actorId,
      objectKind: "view",
      objectId: viewId,
      verb: "view.renamed",
      field: "name",
      oldValue: current.name,
      newValue: trimmed,
    });
  });
}

/** Saves the current definition over the stored one — the "Save" button. */
export async function updateViewDefinition(
  viewId: string,
  definition: ViewDefinition,
  context: ConfigContext,
): Promise<void> {
  const current = await loadRow(pool(), viewId);
  await assertViewCompiles(current.workspace_id, current.parent_id, definition);

  await inTransaction(context, async (client) => {
    await client.query(
      `UPDATE views SET definition = $2, updated_at = now() WHERE id = $1`,
      [viewId, JSON.stringify(definition)],
    );

    await logConfigChange(client, {
      workspaceId: current.workspace_id,
      actorId: context.actorId,
      objectKind: "view",
      objectId: viewId,
      verb: "view.definition_changed",
      field: "definition",
      oldValue: current.definition,
      newValue: definition,
    });
  });
}

/**
 * Copies a view, optionally with a different definition.
 *
 * This is what "save as a new view" means when someone has filtered a shared
 * view and does not want to change it for everyone.
 */
export async function duplicateView(
  viewId: string,
  name: string,
  context: ConfigContext,
  overrides: { definition?: ViewDefinition; ownerId?: string | null } = {},
): Promise<SavedView> {
  const source = await loadRow(pool(), viewId);
  if (!source.parent_id) throw new ConfigError("Cannot duplicate a workspace-wide view yet");

  return createView(
    {
      workspaceId: source.workspace_id,
      parentId: source.parent_id,
      parentKind: (source.parent_kind as "list" | null) ?? "list",
      type: source.type as ViewType,
      name,
      definition: overrides.definition ?? source.definition,
      ownerId: overrides.ownerId ?? source.owner_id,
    },
    context,
  );
}

/**
 * Makes a view the one its container opens on.
 *
 * The old default is cleared in the same transaction. The database also carries
 * a partial unique index, so a second default is impossible rather than merely
 * avoided — this clears the old one so the write succeeds, not so the invariant
 * holds.
 */
export async function setDefaultView(viewId: string, context: ConfigContext): Promise<void> {
  await inTransaction(context, async (client) => {
    const current = await loadRow(client, viewId);

    if (current.owner_id) {
      throw new ConfigError("A personal view cannot be the default for everyone");
    }

    await client.query(
      `UPDATE views SET is_default = false WHERE parent_id = $1 AND is_default`,
      [current.parent_id],
    );
    await client.query(`UPDATE views SET is_default = true WHERE id = $1`, [viewId]);

    await logConfigChange(client, {
      workspaceId: current.workspace_id,
      actorId: context.actorId,
      objectKind: "view",
      objectId: viewId,
      verb: "view.set_default",
      field: "is_default",
      newValue: true,
    });
  });
}

/**
 * Deletes a view, refusing to leave a container with none.
 *
 * A list with no views has nothing to open — the same shape of rule as a status
 * set needing one terminal status. If the deleted view was the default, the
 * next one by position takes over, so the container still has an answer.
 */
export async function deleteView(viewId: string, context: ConfigContext): Promise<void> {
  await inTransaction(context, async (client) => {
    const current = await loadRow(client, viewId);

    const siblings = await client.query<{ id: string }>(
      `SELECT id FROM views
       WHERE parent_id = $1 AND owner_id IS NULL AND id <> $2
       ORDER BY position`,
      [current.parent_id, viewId],
    );

    // A personal view is never the last thing standing — the shared ones remain.
    if (!current.owner_id && siblings.rows.length === 0) {
      throw new ConfigError("This is the only view here — a container needs at least one");
    }

    await client.query(`DELETE FROM views WHERE id = $1`, [viewId]);

    if (current.is_default && siblings.rows[0]) {
      await client.query(`UPDATE views SET is_default = true WHERE id = $1`, [
        siblings.rows[0].id,
      ]);
    }

    await logConfigChange(client, {
      workspaceId: current.workspace_id,
      actorId: context.actorId,
      objectKind: "view",
      objectId: viewId,
      verb: "view.deleted",
      oldValue: { name: current.name, type: current.type },
    });
  });
}

async function loadRow(client: Pool | PoolClient, viewId: string): Promise<ViewRow> {
  const result = await client.query<ViewRow>(
    `SELECT id, workspace_id, name, type, definition, parent_id, parent_kind,
            owner_id, position, is_default
     FROM views WHERE id = $1`,
    [viewId],
  );
  const row = result.rows[0];
  if (!row) throw new ConfigError(`View not found: ${viewId}`);
  return row;
}
