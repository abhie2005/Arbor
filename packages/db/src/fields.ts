import {
  type FieldCatalog,
  type FieldDefinition,
  type FieldType,
  isFieldType,
  parseFieldConfig,
} from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";

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

/** Every live custom field in a workspace, ready to hand to the compiler. */
export async function loadFieldCatalog(
  workspaceId: string,
  connection: Pool = pool(),
): Promise<FieldCatalog> {
  const result = await connection.query<FieldRow>(
    `SELECT id, type, type_config
     FROM fields
     WHERE workspace_id = $1 AND archived_at IS NULL
     ORDER BY position`,
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
