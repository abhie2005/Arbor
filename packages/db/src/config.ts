import type { Pool, PoolClient } from "pg";

import { pool } from "./client";

/**
 * Shared plumbing for the configuration services.
 *
 * Status sets, custom fields, and task types are all edited the same way: a
 * short transaction, a validation pass in @arbor/core, and an activity row so
 * the change is attributable. That last part is why these do not simply use
 * Drizzle inline at each call site — an audit trail assembled by hand at
 * fifteen call sites is an audit trail with holes in it (D-016).
 */

export interface ConfigContext {
  /** Who is making the change. Configuration edits are attributable too. */
  actorId: string;
  connection?: Pool;
}

export class ConfigError extends Error {}

/** Runs `body` inside one transaction, rolling back on any throw. */
export async function inTransaction<T>(
  context: ConfigContext,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!context.actorId) {
    throw new ConfigError("A configuration change needs an actorId");
  }

  const client = await (context.connection ?? pool()).connect();

  try {
    await client.query("BEGIN");
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface ConfigEvent {
  workspaceId: string;
  actorId: string;
  objectKind: "status" | "status_set" | "task_type" | "field" | "container";
  objectId: string;
  verb: string;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
}

export async function logConfigChange(client: PoolClient, event: ConfigEvent): Promise<void> {
  await client.query(
    `INSERT INTO activity
       (workspace_id, actor_id, object_kind, object_id, verb, field, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      event.workspaceId,
      event.actorId,
      event.objectKind,
      event.objectId,
      event.verb,
      event.field ?? null,
      event.oldValue === undefined ? null : JSON.stringify(event.oldValue),
      event.newValue === undefined ? null : JSON.stringify(event.newValue),
    ],
  );
}

export function requireName(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`A ${what} needs a name`);
  }
  const trimmed = value.trim();
  if (trimmed.length > 120) {
    throw new ConfigError(`A ${what} name is limited to 120 characters`);
  }
  return trimmed;
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

export function requireColor(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !HEX_COLOR_RE.test(value)) {
    throw new ConfigError(`"${String(value)}" is not a six-digit hex colour`);
  }
  return value;
}
