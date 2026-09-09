import {
  AMBIENT_NOISE,
  type FanOutContext,
  type NotificationKind,
  type Operation,
  mentionedIds,
  recipientsFor,
  renderPlain,
  summarizeAmbient,
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
 * Writes the notifications one operation implies, and returns who it told.
 *
 * Called from inside `applyOperations`' transaction with its client, so a
 * failure here rolls the operation back with it. `activityId` links the row to
 * what caused it, which is what makes "why am I being told this" answerable.
 *
 * **The ids rather than a count**, because the nudge carries them (D-099): a
 * change that wrote you a notification is a change that moved the badge in
 * every screen's chrome, and it is the only kind that did. Returning a number
 * meant the announcement could not tell the difference, so every screen
 * re-rendered for every change anywhere.
 */
export async function fanOut(
  client: PoolClient,
  op: Operation,
  target: FanOutTarget,
  actorId: string,
  activityId: bigint | null,
): Promise<string[]> {
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
  if (recipients.length === 0) return [];

  const allowed = await reachable(
    client,
    target.listId,
    recipients.map((recipient) => recipient.userId),
  );

  const excerpt = excerptOf(op);
  const told: string[] = [];

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
    told.push(recipient.userId);
  }

  return told;
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

// --- the read-time half -----------------------------------------------------
//
// Everything above is written when it happens, to the few people a change names.
// Everything below is assembled when someone looks, for the many who are
// watching. The split is the schema's, and this is the side that was designed
// first and built last: `notifications` is shaped the way it is *because* this
// query exists, so that one edit to a task with two hundred watchers costs two
// hundred reads of an index rather than two hundred writes of a row.

/** One task's worth of ambient activity, already summarised. */
export interface AmbientRow {
  taskId: string;
  taskKey: string | null;
  taskName: string;
  /** "Riley Kaur and Jordan Diaz changed status and due date" */
  summary: string;
  /** How many activity rows the line stands for. */
  changes: number;
  lastAt: string;
  /** False for a task whose activity the viewer has already marked seen. */
  isNew: boolean;
}

/**
 * What has happened on the tasks someone watches.
 *
 * **Four filters, and each one is load-bearing.**
 *
 * *Watching* is the input list, not the workspace: the query is bounded by how
 * many tasks this person watches rather than by how busy the workspace is, so
 * it stays a handful of index lookups no matter how large `activity` grows.
 *
 * *Access* is joined the same way every other read joins it (ADR 3), on each
 * row's own list — watching a task is not permission to see it, and a watcher
 * whose access was revoked must stop hearing about it immediately.
 *
 * *Your own actions are excluded.* An inbox that tells you what you just did is
 * noise, and it is the first thing anyone notices.
 *
 * *Anything that already sent you a notification is excluded* — that is what
 * `notifications.activity_id` is for. Being mentioned in a comment on a task you
 * watch is one event, and it belongs in the half that is addressed to you.
 */
export async function loadAmbient(
  userId: string,
  workspaceId: string,
  options: { since: Date; seenAt: Date | null; limit?: number },
  connection: Connection = pool(),
): Promise<AmbientRow[]> {
  const { since, seenAt, limit = 50 } = options;

  const result = await connection.query<{
    task_id: string;
    task_key: string | null;
    task_name: string;
    total: string;
    last_at: Date;
    actors: (string | null)[] | null;
    changes: { verb: string; field: string | null }[];
    is_new: boolean;
  }>(
    `WITH seen AS (
       SELECT a.id, a.object_id AS task_id, a.verb, a.field, a.at, u.name AS actor_name
       FROM activity a
       JOIN task_watchers w ON w.task_id = a.object_id AND w.user_id = $1
       JOIN tasks t ON t.id = a.object_id AND t.deleted_at IS NULL
       JOIN access_index ax
         ON ax.list_id = t.home_list_id AND ax.principal_id = $1
       LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.object_kind = 'task'
         AND a.workspace_id = $2
         AND a.at > $3
         AND (a.actor_id IS NULL OR a.actor_id <> $1)
         AND a.verb <> ALL($4::text[])
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.activity_id = a.id AND n.user_id = $1
         )
     )
     SELECT s.task_id, t.key AS task_key, t.name AS task_name,
            count(*)::text AS total,
            max(s.at) AS last_at,
            array_agg(DISTINCT s.actor_name) FILTER (WHERE s.actor_name IS NOT NULL) AS actors,
            jsonb_agg(DISTINCT jsonb_build_object('verb', s.verb, 'field', s.field)) AS changes,
            bool_or($5::timestamptz IS NULL OR s.at > $5::timestamptz) AS is_new
     FROM seen s
     JOIN tasks t ON t.id = s.task_id
     GROUP BY s.task_id, t.key, t.name
     ORDER BY max(s.at) DESC
     LIMIT $6`,
    [userId, workspaceId, since, [...AMBIENT_NOISE], seenAt, limit],
  );

  return result.rows.map((row) => ({
    taskId: row.task_id,
    taskKey: row.task_key,
    taskName: row.task_name,
    // Summarised in `@arbor/core`, not here: what a group of changes reads as
    // is a rule worth testing without a database.
    summary: summarizeAmbient({
      actors: (row.actors ?? []).filter((name): name is string => name !== null),
      changes: row.changes ?? [],
      total: Number(row.total),
    }),
    changes: Number(row.total),
    lastAt: row.last_at.toISOString(),
    isNew: row.is_new,
  }));
}

/**
 * The mark on the feed, and where it is.
 *
 * One timestamp per membership rather than a read flag per event — the whole
 * point of aggregating at read time is that watching something costs no writes,
 * and a per-row flag would spend them right back.
 */
export async function activitySeen(
  userId: string,
  workspaceId: string,
  connection: Connection = pool(),
): Promise<Date | null> {
  const result = await connection.query<{ activity_seen_at: Date | null }>(
    `SELECT activity_seen_at FROM memberships WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  );

  return result.rows[0]?.activity_seen_at ?? null;
}

/**
 * Marks the feed caught up.
 *
 * An update rather than an upsert: the row exists for everyone who is in the
 * workspace, and someone who is not has no inbox in it to mark. A caller who
 * passes a workspace the user is not a member of updates nothing, which is the
 * same shape of refusal as marking someone else's notification read.
 */
export async function markActivitySeen(
  userId: string,
  workspaceId: string,
  connection: Connection = pool(),
): Promise<void> {
  await connection.query(
    `UPDATE memberships SET activity_seen_at = now()
     WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  );
}
