import { type RichDoc, parseStoredDoc } from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";

/**
 * Reading comments. Writing them is `applyOperations` (D-083).
 *
 * There is no `createComment` function here on purpose. Every write in this
 * system is an operation, and a comment service with its own INSERT would be
 * the second thing that writes and therefore the first thing to forget an
 * activity row. This file loads; the executor writes.
 */

type Connection = Pool | PoolClient;

export interface CommentAuthor {
  id: string | null;
  name: string;
}

export interface CommentRecord {
  id: string;
  parentId: string | null;
  author: CommentAuthor;
  /**
   * Null when the stored JSON does not parse as a document.
   *
   * It is a value rather than a throw because one unreadable row must not take
   * a page down with it — the panel renders that comment as unreadable and the
   * rest normally.
   */
  body: RichDoc | null;
  createdAt: string;
  updatedAt: string;
  /** Set means a tombstone: the row stays so its replies keep their anchor. */
  deletedAt: string | null;
  edited: boolean;
  replies: CommentRecord[];
}

interface CommentRow {
  id: string;
  parent_id: string | null;
  author_id: string | null;
  author_name: string | null;
  body: unknown;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

/**
 * Every comment on a task, threaded one level deep.
 *
 * **Deleted comments are returned, not filtered.** A deleted comment that had
 * replies is the anchor those replies answer; removing it would leave a
 * conversation whose first half is missing and whose second half no longer
 * makes sense. The caller renders a tombstone. A deleted comment with no
 * replies is dropped, because there is nothing left for it to hold up.
 *
 * One query, assembled in memory: a task has tens of comments, not thousands,
 * and a recursive CTE to build a two-level tree would be more machinery than
 * the shape deserves.
 */
export async function loadComments(
  taskId: string,
  connection: Connection = pool(),
): Promise<CommentRecord[]> {
  const result = await connection.query<CommentRow>(
    `SELECT c.id, c.parent_id, c.author_id, u.name AS author_name,
            c.body, c.created_at, c.updated_at, c.deleted_at
     FROM comments c
     LEFT JOIN users u ON u.id = c.author_id
     WHERE c.object_kind = 'task' AND c.object_id = $1
     ORDER BY c.created_at`,
    [taskId],
  );

  const toRecord = (row: CommentRow): CommentRecord => ({
    id: row.id,
    parentId: row.parent_id,
    author: {
      id: row.author_id,
      // A comment outlives its author's account (`ON DELETE SET NULL`), and it
      // still has to say who wrote it as far as it can.
      name: row.author_name ?? "Someone who has left",
    },
    body: row.deleted_at ? null : parseStoredDoc(row.body),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null,
    // A second's grace: `updated_at` defaults to `now()` on insert, so an
    // untouched comment can differ from `created_at` by microseconds.
    edited:
      row.deleted_at === null &&
      row.updated_at.getTime() - row.created_at.getTime() > 1000,
    replies: [],
  });

  const records = result.rows.map(toRecord);
  const byId = new Map(records.map((record) => [record.id, record]));

  const roots: CommentRecord[] = [];
  for (const record of records) {
    if (record.parentId) {
      byId.get(record.parentId)?.replies.push(record);
    } else {
      roots.push(record);
    }
  }

  return roots.filter((root) => root.deletedAt === null || root.replies.length > 0);
}

/**
 * Who may change this comment, and which task it belongs to.
 *
 * Editing and deleting are **the author's**, not an editor's. Someone with
 * `edit` on the list may change the task in every way the panel offers; they
 * may not rewrite what another person said, because a comment is a record of
 * having said something and an edit by anyone else makes the record a lie.
 * The task's `taskId` comes back so the caller can authorize against the list
 * as well — being the author is not enough if you have since lost access.
 */
export async function commentOwnership(
  commentId: string,
  connection: Connection = pool(),
): Promise<{ taskId: string; authorId: string | null; deleted: boolean } | null> {
  const result = await connection.query<{
    object_id: string;
    author_id: string | null;
    deleted_at: Date | null;
  }>(
    `SELECT object_id, author_id, deleted_at
     FROM comments WHERE id = $1 AND object_kind = 'task'`,
    [commentId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return { taskId: row.object_id, authorId: row.author_id, deleted: row.deleted_at !== null };
}

/** Comment counts for a set of tasks, for the row and card badges. */
export async function commentCounts(
  taskIds: readonly string[],
  connection: Connection = pool(),
): Promise<Map<string, number>> {
  if (taskIds.length === 0) return new Map();

  const result = await connection.query<{ object_id: string; n: string }>(
    `SELECT object_id, count(*) AS n
     FROM comments
     WHERE object_kind = 'task' AND object_id = ANY($1::uuid[]) AND deleted_at IS NULL
     GROUP BY object_id`,
    [taskIds],
  );

  return new Map(result.rows.map((row) => [row.object_id, Number(row.n)]));
}
