import {
  type FanOutContext,
  type NotificationKind,
  type Operation,
  mentionedIds,
  parseStoredDoc,
  recipientsFor,
  renderPlain,
} from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";

/**
 * Turning an operation into notifications, inside the transaction that caused it.
 *
 * **Inside, deliberately.** A comment and the fact that it told someone about
 * itself either both happened or neither did; a fan-out that runs after the
 * commit can be lost to a crash, and a lost notification leaves no trace
 * anywhere — nothing detects the silence. The usual objection is cost, and it
 * does not apply here: only *directly named* people get a row (the schema's own
 * rule), so the work is proportional to the number of people a comment mentions
 * rather than to how many are watching. The read-time half over `activity` is
 * what keeps a two-hundred-watcher task from writing two hundred rows.
 *
 * The rule about *who* is a pure function in `@arbor/core`; this file loads the
 * facts it cannot derive and writes the rows.
 */

type Connection = Pool | PoolClient;

/**
 * Never notify someone about a task they cannot open.
 *
 * The mention flow already asks before posting a comment that names someone
 * without access (D-084), but that is not the only path in: an assignment does
 * not ask, access can be revoked between the comment and the read, and the
 * worker will eventually apply operations with no UI in front of it at all.
 * So the guard lives here, at the write, rather than in any one caller.
 *
 * The inbox filters again on read for the same reason — access granted today
 * can be gone tomorrow, and a notification row is not a permission.
 */
async function reachable(
  client: Connection,
  listId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const result = await client.query<{ principal_id: string }>(
    `SELECT principal_id FROM access_index
     WHERE list_id = $1 AND principal_id = ANY($2::uuid[])`,
    [listId, [...userIds]],
  );

  return new Set(result.rows.map((row) => row.principal_id));
}

/**
 * Whether this operation could notify anyone, cheaply.
 *
 * The pure rule answers the same question properly, but only after the context
 * it needs has been loaded. This is the gate that decides whether to load it at
 * all, so a status change — by far the most common operation — costs one
 * comparison rather than a query.
 *
 * It lives beside `recipientsFor`'s caller rather than beside `recipientsFor`
 * itself so the two cannot drift: the kinds listed here are exactly the kinds
 * that function has a case for.
 */
export function mayNotify(op: Operation): boolean {
  if (op.kind === "addRelation") return op.relation === "assignee";
  return op.kind === "createComment" || op.kind === "editComment" || op.kind === "setDescription";
}

export interface FanOutTarget {
  workspaceId: string;
  listId: string;
  taskId: string;
  taskKey: string | null;
  taskName: string;
  actorName: string;
}

/**
 * The `payload` the schema asks for: a rendered summary, so an inbox row needs
 * no joins to display. Written once, at fan-out, because the words a
 * notification is *about* are the words as they were — a summary re-derived at
 * read time would silently change when the comment it describes is edited.
 */
function payloadFor(
  kind: NotificationKind,
  target: FanOutTarget,
  excerpt: string | null,
): Record<string, unknown> {
  const summary =
    kind === "assigned"
      ? `${target.actorName} assigned you`
      : kind === "replied"
        ? `${target.actorName} replied to your comment`
        : `${target.actorName} mentioned you`;

  return {
    summary,
    taskKey: target.taskKey,
    taskName: target.taskName,
    // Trimmed here rather than in the renderer: the inbox shows a line, and
    // storing a paragraph to display forty characters of it is waste that
    // every read pays for.
    excerpt: excerpt === null ? null : excerpt.slice(0, 240),
  };
}

/**
 * Everything a notification's payload names, in one query.
 *
 * Loaded per operation that might notify, not per operation: `mayNotify` is the
 * gate, so a board drag pays nothing for this.
 */
export async function fanOutTarget(
  client: Connection,
  taskId: string,
  actorId: string,
): Promise<FanOutTarget | null> {
  const result = await client.query<{
    workspace_id: string;
    home_list_id: string;
    key: string | null;
    name: string;
    actor_name: string | null;
  }>(
    `SELECT t.workspace_id, t.home_list_id, t.key, t.name,
            (SELECT name FROM users WHERE id = $2) AS actor_name
     FROM tasks t WHERE t.id = $1`,
    [taskId, actorId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    workspaceId: row.workspace_id,
    listId: row.home_list_id,
    taskId,
    taskKey: row.key,
    taskName: row.name,
    actorName: row.actor_name ?? "Someone",
  };
}

/**
 * Writes the notifications one operation implies.
 *
 * Called from inside `applyOperations`' transaction with its client, so a
 * failure here rolls the operation back with it. `activityId` links the row to
 * what caused it, which is what makes "why am I being told this" answerable.
 */
export async function fanOut(
  client: PoolClient,
  op: Operation,
  target: FanOutTarget,
  actorId: string,
  activityId: bigint | null,
): Promise<number> {
  const context: FanOutContext = { actorId };

  // Two facts the pure rule cannot derive, each loaded only when the operation
  // is the kind that needs it.
  if (op.kind === "createComment" && op.parentId) {
    const parent = await client.query<{ author_id: string | null }>(
      `SELECT author_id FROM comments WHERE id = $1`,
      [op.parentId],
    );
    context.parentAuthorId = parent.rows[0]?.author_id ?? null;
  }

  if (op.kind === "setDescription") {
    context.previouslyMentioned = op.from ? mentionedIds(op.from) : [];
  }

  const recipients = recipientsFor(op, context);
  if (recipients.length === 0) return 0;

  const allowed = await reachable(
    client,
    target.listId,
    recipients.map((recipient) => recipient.userId),
  );

  const excerpt = excerptOf(op);
  let written = 0;

  for (const recipient of recipients) {
    if (!allowed.has(recipient.userId)) continue;

    await client.query(
      `INSERT INTO notifications
         (workspace_id, user_id, activity_id, kind, task_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        target.workspaceId,
        recipient.userId,
        activityId === null ? null : activityId.toString(),
        recipient.kind,
        target.taskId,
        JSON.stringify(payloadFor(recipient.kind, target, excerpt)),
      ],
    );
    written += 1;
  }

  return written;
}

/** What the notification is about, in the words that were written. */
function excerptOf(op: Operation): string | null {
  if (op.kind === "createComment") return renderPlain(op.body);
  if (op.kind === "editComment") return renderPlain(op.to);
  if (op.kind === "setDescription") return op.to ? renderPlain(op.to) : null;
  return null;
}

export interface InboxRow {
  id: string;
  kind: NotificationKind;
  taskId: string | null;
  taskKey: string | null;
  taskName: string;
  summary: string;
  excerpt: string | null;
  isRead: boolean;
  createdAt: string;
}

/**
 * Someone's inbox.
 *
 * **The first query in the app that is not scoped to one container.** Every
 * other read names a list and joins `access_index` for it; this one asks "what
 * is mine, anywhere", and still has to answer only with tasks the viewer can
 * currently open. So the join is the same one, on each row's own list, rather
 * than on a list known in advance.
 *
 * Filtering on read as well as on write is not belt-and-braces: a grant can be
 * revoked after a notification is written, and a notification row is a record
 * that something happened, not a licence to see it.
 */
export async function loadInbox(
  userId: string,
  options: { includeRead?: boolean; limit?: number } = {},
  connection: Connection = pool(),
): Promise<InboxRow[]> {
  const { includeRead = false, limit = 50 } = options;

  const result = await connection.query<{
    id: string;
    kind: NotificationKind;
    task_id: string | null;
    task_key: string | null;
    task_name: string | null;
    payload: Record<string, unknown>;
    is_read: boolean;
    created_at: Date;
  }>(
    `SELECT n.id, n.kind, n.task_id, t.key AS task_key, t.name AS task_name,
            n.payload, n.is_read, n.created_at
     FROM notifications n
     JOIN tasks t ON t.id = n.task_id
     JOIN access_index ax
       ON ax.list_id = t.home_list_id AND ax.principal_id = n.user_id
     WHERE n.user_id = $1
       AND n.cleared_at IS NULL
       AND t.deleted_at IS NULL
       AND ($2::boolean OR n.is_read = false)
     ORDER BY n.created_at DESC
     LIMIT $3`,
    [userId, includeRead, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    taskId: row.task_id,
    // The stored payload is what it said at the time; the joined name is what
    // it says now. The name is the link's label, so it uses the current one —
    // a renamed task should be findable by the name it has.
    taskKey: row.task_key ?? (row.payload.taskKey as string | null) ?? null,
    taskName: row.task_name ?? (row.payload.taskName as string) ?? "",
    summary: (row.payload.summary as string) ?? "Something happened",
    excerpt: (row.payload.excerpt as string | null) ?? null,
    isRead: row.is_read,
    createdAt: row.created_at.toISOString(),
  }));
}

/** The badge. Same scoping as the inbox, because a count you cannot open is a lie. */
export async function unreadCount(
  userId: string,
  connection: Connection = pool(),
): Promise<number> {
  const result = await connection.query<{ n: string }>(
    `SELECT count(*) AS n
     FROM notifications n
     JOIN tasks t ON t.id = n.task_id
     JOIN access_index ax
       ON ax.list_id = t.home_list_id AND ax.principal_id = n.user_id
     WHERE n.user_id = $1 AND n.is_read = false AND n.cleared_at IS NULL
       AND t.deleted_at IS NULL`,
    [userId],
  );

  return Number(result.rows[0]?.n ?? 0);
}

/** Marks one notification read. Scoped to its owner: an id is not permission. */
export async function markRead(
  notificationId: string,
  userId: string,
  connection: Connection = pool(),
): Promise<void> {
  await connection.query(
    `UPDATE notifications SET is_read = true, read_at = now()
     WHERE id = $1 AND user_id = $2 AND is_read = false`,
    [notificationId, userId],
  );
}

export async function markAllRead(
  userId: string,
  connection: Connection = pool(),
): Promise<number> {
  const result = await connection.query(
    `UPDATE notifications SET is_read = true, read_at = now()
     WHERE user_id = $1 AND is_read = false`,
    [userId],
  );
  return result.rowCount ?? 0;
}
