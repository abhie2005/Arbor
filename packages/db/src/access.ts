import {
  type AccessInputs,
  type AccessRow,
  type ContainerNode,
  type Permission,
  PERMISSIONS,
  resolveAccess,
} from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";
import { type ConfigContext, ConfigError, inTransaction, logConfigChange } from "./config";

/**
 * Grants in, access index out.
 *
 * ADR 3 splits permissions in two: `grants` are the truth and are cheap to
 * write, and `access_index` is the flattened answer every task query joins
 * against. This file is the job in between. The rule itself lives in
 * `@arbor/core` and has no database in it - what is here is loading the inputs,
 * writing the rows, and doing both inside one transaction so a viewer never
 * observes a half-rebuilt index.
 *
 * **The rebuild is idempotent by construction**: delete the rows for the lists
 * being recomputed, insert what the rule says. Running it twice changes
 * nothing, which is the property that lets it be re-run whenever anything is
 * unsure rather than only on the exact events that require it.
 */

type Connection = Pool | PoolClient;

interface ContainerRow {
  id: string;
  parent_id: string | null;
  kind: "space" | "folder" | "list";
  name: string;
  is_private: boolean;
}

/**
 * Everything the rule needs, one query per table.
 *
 * Sequential, not `Promise.all`. A `Pool` hands each concurrent query its own
 * client, but a `PoolClient` — which is what this gets when a grant is being
 * written inside a transaction — can only run one query at a time, and issuing
 * four at once against one is undefined behaviour that pg deprecates loudly and
 * will refuse in version 9. Four small indexed reads do not need the
 * concurrency.
 */
export async function loadAccessInputs(
  workspaceId: string,
  connection: Connection = pool(),
): Promise<AccessInputs> {
  const containers = await connection.query<ContainerRow>(
    `SELECT id, parent_id, kind, name, is_private FROM containers WHERE workspace_id = $1`,
    [workspaceId],
  );

  const grants = await connection.query<{
    container_id: string;
    principal_kind: "user" | "group";
    principal_id: string;
    permission: Permission;
  }>(
    `SELECT g.container_id, g.principal_kind, g.principal_id, g.permission
     FROM grants g JOIN containers c ON c.id = g.container_id
     WHERE c.workspace_id = $1`,
    [workspaceId],
  );

  const members = await connection.query<{ user_id: string; role: string }>(
    `SELECT user_id, role FROM memberships WHERE workspace_id = $1`,
    [workspaceId],
  );

  const groupMembers = await connection.query<{ group_id: string; user_id: string }>(
    `SELECT m.group_id, m.user_id
     FROM user_group_members m JOIN user_groups g ON g.id = m.group_id
     WHERE g.workspace_id = $1`,
    [workspaceId],
  );

  return {
    containers: containers.rows.map(
      (row): ContainerNode => ({
        id: row.id,
        parentId: row.parent_id,
        kind: row.kind,
        name: row.name,
        isPrivate: row.is_private,
      }),
    ),
    grants: grants.rows.map((row) => ({
      containerId: row.container_id,
      principalKind: row.principal_kind,
      principalId: row.principal_id,
      permission: row.permission,
    })),
    members: members.rows.map((row) => ({
      userId: row.user_id,
      role: row.role as AccessInputs["members"][number]["role"],
    })),
    groupMembers: groupMembers.rows.map((row) => ({
      groupId: row.group_id,
      userId: row.user_id,
    })),
  };
}

/**
 * Recomputes the whole workspace's index.
 *
 * Whole-workspace rather than incremental on purpose. A workspace's container
 * tree is small - hundreds of rows, not millions - and an incremental rebuild
 * has to work out what a change implies, which is exactly the reasoning that
 * goes wrong quietly. `affectedLists` exists for when that becomes worth doing;
 * until a workspace is big enough to notice, recomputing everything is the
 * version that cannot drift.
 */
export async function rebuildAccessIndex(
  workspaceId: string,
  connection: Connection = pool(),
): Promise<AccessRow[]> {
  const inputs = await loadAccessInputs(workspaceId, connection);
  const rows = resolveAccess(inputs);

  const write = async (client: Connection) => {
    await client.query(`DELETE FROM access_index WHERE workspace_id = $1`, [workspaceId]);
    if (rows.length === 0) return;

    // One statement with unnested arrays rather than a row per insert: a
    // workspace rebuild is a few thousand rows and this is the difference
    // between one round trip and a few thousand.
    await client.query(
      `INSERT INTO access_index (workspace_id, principal_id, list_id, permission)
       SELECT $1, p.principal_id, p.list_id, p.permission::permission
       FROM unnest($2::uuid[], $3::uuid[], $4::text[])
         AS p(principal_id, list_id, permission)`,
      [
        workspaceId,
        rows.map((row) => row.principalId),
        rows.map((row) => row.listId),
        rows.map((row) => row.permission),
      ],
    );
  };

  // Already inside a transaction when a caller passes its client; otherwise
  // open one, because a delete without its insert is a workspace nobody can see.
  if (isClient(connection)) await write(connection);
  else await inTransactionless(connection, write);

  return rows;
}

function isClient(connection: Connection): connection is PoolClient {
  return typeof (connection as PoolClient).release === "function";
}

async function inTransactionless(
  connection: Pool,
  body: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await connection.connect();
  try {
    await client.query("BEGIN");
    await body(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function workspaceOf(client: PoolClient, containerId: string): Promise<string> {
  const result = await client.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM containers WHERE id = $1`,
    [containerId],
  );
  const workspaceId = result.rows[0]?.workspace_id;
  if (!workspaceId) throw new ConfigError(`Container not found: ${containerId}`);
  return workspaceId;
}

function requirePermission(value: unknown): Permission {
  if (typeof value !== "string" || !PERMISSIONS.includes(value as Permission)) {
    throw new ConfigError(`Unknown permission: ${String(value)}`);
  }
  return value as Permission;
}

export interface GrantInput {
  containerId: string;
  principalKind: "user" | "group";
  principalId: string;
  permission: Permission;
}

/**
 * Shares a container with someone, or changes what they may do with it.
 *
 * The index is rebuilt inside the same transaction as the grant, so there is no
 * window in which the grant exists and the access it implies does not. That
 * costs a full rebuild per share, which is the right trade at this size: the
 * alternative is a queue and an eventually-consistent window, and eventual
 * consistency on a *revocation* is someone still reading what was taken away.
 */
export async function grantAccess(input: GrantInput, context: ConfigContext): Promise<void> {
  const permission = requirePermission(input.permission);

  await inTransaction(context, async (client) => {
    const workspaceId = await workspaceOf(client, input.containerId);

    const previous = await client.query<{ permission: Permission }>(
      `SELECT permission FROM grants
       WHERE container_id = $1 AND principal_kind = $2 AND principal_id = $3`,
      [input.containerId, input.principalKind, input.principalId],
    );

    await client.query(
      `INSERT INTO grants (container_id, principal_kind, principal_id, permission, granted_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (container_id, principal_kind, principal_id)
       DO UPDATE SET permission = EXCLUDED.permission`,
      [input.containerId, input.principalKind, input.principalId, permission, context.actorId],
    );

    await logConfigChange(client, {
      workspaceId,
      actorId: context.actorId,
      objectKind: "container",
      objectId: input.containerId,
      verb: previous.rows[0] ? "container.access_changed" : "container.shared",
      field: `${input.principalKind}:${input.principalId}`,
      oldValue: previous.rows[0]?.permission ?? null,
      newValue: permission,
    });

    await rebuildAccessIndex(workspaceId, client);
  });
}

export async function revokeAccess(
  containerId: string,
  principalKind: "user" | "group",
  principalId: string,
  context: ConfigContext,
): Promise<void> {
  await inTransaction(context, async (client) => {
    const workspaceId = await workspaceOf(client, containerId);

    const removed = await client.query<{ permission: Permission }>(
      `DELETE FROM grants
       WHERE container_id = $1 AND principal_kind = $2 AND principal_id = $3
       RETURNING permission`,
      [containerId, principalKind, principalId],
    );

    if (!removed.rows[0]) {
      throw new ConfigError("That principal does not have a grant on this container");
    }

    await logConfigChange(client, {
      workspaceId,
      actorId: context.actorId,
      objectKind: "container",
      objectId: containerId,
      verb: "container.unshared",
      field: `${principalKind}:${principalId}`,
      oldValue: removed.rows[0].permission,
      newValue: null,
    });

    await rebuildAccessIndex(workspaceId, client);
  });
}

/**
 * Makes a container private, or opens it again.
 *
 * Privacy is inherited downward and cannot be loosened below a private ancestor
 * (`isEffectivelyPrivate`), so opening a folder inside a private space changes
 * nothing about who can reach it - which this refuses to pretend otherwise
 * about rather than silently accepting.
 */
export async function setContainerPrivacy(
  containerId: string,
  isPrivate: boolean,
  context: ConfigContext,
): Promise<AccessRow[]> {
  return inTransaction(context, async (client) => {
    const workspaceId = await workspaceOf(client, containerId);

    const current = await client.query<{ is_private: boolean }>(
      `SELECT is_private FROM containers WHERE id = $1`,
      [containerId],
    );

    if (current.rows[0]?.is_private === isPrivate) {
      return rebuildAccessIndex(workspaceId, client);
    }

    await client.query(`UPDATE containers SET is_private = $1, updated_at = now() WHERE id = $2`, [
      isPrivate,
      containerId,
    ]);

    await logConfigChange(client, {
      workspaceId,
      actorId: context.actorId,
      objectKind: "container",
      objectId: containerId,
      verb: isPrivate ? "container.made_private" : "container.made_open",
      field: "is_private",
      oldValue: current.rows[0]?.is_private ?? false,
      newValue: isPrivate,
    });

    return rebuildAccessIndex(workspaceId, client);
  });
}

export interface ContainerGrant {
  containerId: string;
  containerName: string;
  principalKind: "user" | "group";
  principalId: string;
  principalName: string;
  permission: Permission;
  /** True when the grant sits on an ancestor rather than on this container. */
  inherited: boolean;
}

/**
 * The grants that apply to a container, its own and the ones it inherits.
 *
 * A sharing panel that shows only a container's own grants tells someone their
 * list is unshared while the space above it is shared with everyone.
 */
export async function listGrants(
  containerId: string,
  connection: Connection = pool(),
): Promise<ContainerGrant[]> {
  const result = await connection.query<{
    container_id: string;
    container_name: string;
    principal_kind: "user" | "group";
    principal_id: string;
    principal_name: string | null;
    permission: Permission;
    inherited: boolean;
  }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id, name, 0 AS depth FROM containers WHERE id = $1
       UNION ALL
       SELECT c.id, c.parent_id, c.name, chain.depth + 1
       FROM containers c JOIN chain ON c.id = chain.parent_id
     )
     SELECT g.container_id,
            chain.name AS container_name,
            g.principal_kind,
            g.principal_id,
            COALESCE(u.name, ug.name) AS principal_name,
            g.permission,
            chain.depth > 0 AS inherited
     FROM chain
     JOIN grants g ON g.container_id = chain.id
     LEFT JOIN users u ON u.id = g.principal_id AND g.principal_kind = 'user'
     LEFT JOIN user_groups ug ON ug.id = g.principal_id AND g.principal_kind = 'group'
     ORDER BY chain.depth, COALESCE(u.name, ug.name)`,
    [containerId],
  );

  return result.rows.map((row) => ({
    containerId: row.container_id,
    containerName: row.container_name,
    principalKind: row.principal_kind,
    principalId: row.principal_id,
    principalName: row.principal_name ?? "(removed)",
    permission: row.permission,
    inherited: row.inherited,
  }));
}
