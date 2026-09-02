import { type ContainerNode, indexById } from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";

/**
 * Container reads.
 *
 * Its own module rather than a helper inside the status service, because both
 * status sets and custom fields resolve against the tree — and importing the
 * tree loader from the status service would have made fields, statuses, and
 * mutations a three-way import cycle.
 */

/** Every live container in a workspace, in the shape @arbor/core walks. */
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
