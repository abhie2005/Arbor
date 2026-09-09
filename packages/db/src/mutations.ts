import {
  type Operation,
  type TimeEntryValues,
  activityVerb,
  fieldValueColumn,
  isNoop,
  parseFieldValue,
  parseStoredDoc,
  renderPlain,
  validateTimeEntry,
} from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";
import { loadField } from "./fields";
import { announceChange } from "./live";
import { fanOut, fanOutTarget, mayNotify } from "./notifications";

/**
 * Applies operations and records them.
 *
 * The whole batch runs in **one transaction**, so a bulk edit either lands
 * completely or not at all — a half-applied selection is impossible to
 * communicate to a user and impossible to undo correctly.
 *
 * Every operation writes both its table change and its activity row here, in
 * the same place. Assembling log rows at each call site is how field changes
 * silently stop being recorded once there are thirty call sites.
 *
 * This lives in the data layer rather than the web app on purpose: the worker
 * applies operations too, because that is exactly what an automation action is.
 * The caller supplies the actor — the web app from its session, the worker from
 * the automation — so identity stays the concern of whoever has it.
 */

/**
 * Columns an operation may write, mapped to their SQL names.
 *
 * Closed map, same reasoning as the view compiler (D-018): `Operation.field` is
 * ultimately shaped by client input, so it must never reach a query as text.
 */
const FIELD_COLUMNS = {
  name: "name",
  statusId: "status_id",
  priority: "priority",
  dueAt: "due_at",
  startAt: "start_at",
  points: "points",
  timeEstimateMs: "time_estimate_ms",
  parentTaskId: "parent_task_id",
  homeListId: "home_list_id",
  taskTypeId: "task_type_id",
  position: "position",
} as const;

/**
 * Every typed column on `field_values`. A row populates exactly one of them,
 * chosen by the field's type; the rest are cleared on write.
 */
const VALUE_COLUMNS = ["value_text", "value_num", "value_date", "value_bool", "value_json"] as const;

/**
 * `duration_ms`, computed from the two instants rather than accepted from
 * anyone.
 *
 * The column is denormalized on stop so a timesheet sums a column instead of
 * subtracting timestamps across a million rows — which makes it derived data
 * living next to the data it derives from, and the only way those two can
 * disagree is if something writes the derived half directly. So nothing does:
 * the operation carries the instants, this expression carries the arithmetic,
 * and both writes that can produce a duration use this string.
 */
const DURATION_MS = `CASE
  WHEN $ENDED::timestamptz IS NULL THEN NULL
  ELSE (EXTRACT(EPOCH FROM ($ENDED::timestamptz - $STARTED::timestamptz)) * 1000)::bigint
END`;

const RELATION_TABLES = {
  assignee: { table: "task_assignees", column: "user_id" },
  watcher: { table: "task_watchers", column: "user_id" },
  tag: { table: "task_tags", column: "tag_id" },
} as const;

export class MutationRejected extends Error {}

export interface ApplyResult {
  applied: number;
  skipped: number;
  /** Notification rows written inside this transaction. */
  notified: number;
}

export interface ApplyContext {
  /** Who is making the change. Required — see the note on logActivity. */
  actorId: string;
  connection?: Pool;
  /**
   * An open transaction to join instead of opening one.
   *
   * Configuration changes need this: deleting a status moves every task that
   * used it and then removes the status, and those two must not be separable.
   * Without it the caller either gives up atomicity or reimplements the
   * executor, and a second executor is how the activity log starts missing rows.
   *
   * The caller owns the transaction — this will not COMMIT or ROLLBACK one it
   * did not open.
   */
  client?: PoolClient;
}

export async function applyOperations(
  ops: readonly Operation[],
  context: ApplyContext,
): Promise<ApplyResult> {
  if (!context.actorId) {
    // An activity log with a null author is worse than no log, because it still
    // looks trustworthy.
    throw new MutationRejected("applyOperations requires an actorId");
  }

  // Filter no-ops before opening a transaction: clicking the status a task
  // already has should not write a row or broadcast a delta.
  const meaningful = ops.filter((op) => !isNoop(op));
  if (meaningful.length === 0) return { applied: 0, skipped: ops.length, notified: 0 };

  const result = {
    applied: meaningful.length,
    skipped: ops.length - meaningful.length,
    notified: 0,
  };

  // Joining a caller's transaction: no BEGIN, no COMMIT, no release. Throwing
  // is still correct — the caller's rollback covers these statements too. The
  // announcement still happens here and is still transactional, because NOTIFY
  // is delivered at the *caller's* commit.
  if (context.client) {
    const heard = new Announcements(context.actorId);
    for (const op of meaningful) {
      result.notified += await applyAndNotify(context.client, op, context.actorId, heard);
    }
    await heard.announce(context.client);
    return result;
  }

  const client = await (context.connection ?? pool()).connect();

  try {
    await client.query("BEGIN");

    const heard = new Announcements(context.actorId);
    for (const op of meaningful) {
      result.notified += await applyAndNotify(client, op, context.actorId, heard);
    }
    await heard.announce(client);

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * What this batch will tell the world, collected while it runs.
 *
 * **The announcement moved out of `logActivity` and up to here** (D-099), which
 * is the one thing about this refactor worth being nervous about: broadcasting
 * from inside the function every operation already passes through was what made
 * "a new operation cannot forget to broadcast" true by construction (D-090).
 * That property is not lost, it moved — `applyOperations` is the only way to
 * apply an operation at all, so a batch cannot forget either, and there is now
 * one announcement per batch instead of one per operation.
 *
 * It had to move because the interesting part of a nudge is not knowable when
 * `logActivity` runs. Whether a change wrote somebody a notification is decided
 * by the fan-out, which happens *after* the activity row exists — so a nudge
 * emitted from inside the log could never say who it was for, and every screen
 * had to re-render for every change anywhere.
 *
 * Grouped by list, because that is what a subscriber's access is checked
 * against and what a page compares itself to. A bulk edit of two hundred tasks
 * in one list was already collapsing to one delivery inside Postgres; now it is
 * one call.
 */
class Announcements {
  private readonly lists = new Map<string, { w: string; n: Set<string>; t: Set<string> }>();

  constructor(private readonly actorId: string) {}

  touch(workspaceId: string, listId: string): void {
    if (!this.lists.has(listId)) {
      this.lists.set(listId, { w: workspaceId, n: new Set(), t: new Set() });
    }
  }

  notified(listId: string, userIds: readonly string[]): void {
    const entry = this.lists.get(listId);
    for (const id of userIds) entry?.n.add(id);
  }

  timer(listId: string, userId: string): void {
    this.lists.get(listId)?.t.add(userId);
  }

  async announce(client: PoolClient): Promise<void> {
    for (const [listId, entry] of this.lists) {
      await announceChange(client, {
        w: entry.w,
        l: listId,
        a: this.actorId,
        // Omitted when empty rather than sent as `[]`, so the common change —
        // a status click that notified nobody — carries no extra bytes and the
        // client's check stays a single optional-chained call.
        ...(entry.n.size > 0 ? { n: [...entry.n] } : {}),
        ...(entry.t.size > 0 ? { t: [...entry.t] } : {}),
      });
    }
  }
}

/**
 * Applies one operation and tells whoever it was addressed to.
 *
 * **Inside the transaction, on purpose.** A comment and the fact that it told
 * someone about itself either both happened or neither did — a fan-out after
 * the commit can be lost to a crash, and a lost notification is invisible:
 * nothing anywhere detects that a message was not sent.
 *
 * The usual objection to doing it here is cost, and it does not apply. Only
 * *directly named* people get a row (the `notifications` table's own rule), so
 * this is proportional to how many people a comment mentions, not to how many
 * are watching. `mayNotify` means every other operation pays one comparison.
 */
async function applyAndNotify(
  client: PoolClient,
  op: Operation,
  actorId: string,
  heard: Announcements,
): Promise<number> {
  const logged = await applyOne(client, op, actorId, heard);
  if (!mayNotify(op)) return 0;

  const target = await fanOutTarget(client, op.taskId, actorId);
  if (!target) return 0;

  const told = await fanOut(client, op, target, actorId, logged.id);

  // Onto the *task's own* list, which is where the activity row went too — a
  // notification about a task belongs to the list that task lives in, whatever
  // else this batch touched.
  heard.notified(logged.listId, told);
  return told.length;
}

interface Logged {
  id: bigint;
  workspaceId: string;
  listId: string;
}

async function applyOne(
  client: PoolClient,
  op: Operation,
  actorId: string,
  heard: Announcements,
): Promise<Logged> {
  switch (op.kind) {
    case "setField": {
      const column = FIELD_COLUMNS[op.field];
      if (!column) throw new MutationRejected(`Field is not writable: ${op.field}`);

      // Completion is derived, not set by the client: moving a task into a
      // `done` status stamps completed_at, moving it out clears it. Leaving
      // this to callers means the timestamp drifts out of sync with status.
      const completion =
        op.field === "statusId"
          ? `, completed_at = CASE
               WHEN (SELECT "group" FROM statuses WHERE id = $2) IN ('done','closed')
                 THEN COALESCE(tasks.completed_at, now())
               ELSE NULL
             END`
          : "";

      const result = await client.query(
        `UPDATE tasks
         SET ${column} = $2, updated_at = now()${completion}
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING workspace_id, home_list_id`,
        [op.taskId, op.to],
      );

      const row = requireRow(result.rows[0], op.taskId);
      return await logActivity(client, heard, {
        op,
        actorId,
        workspaceId: row.workspace_id,
        listId: row.home_list_id,
        field: column,
        oldValue: op.from,
        newValue: op.to,
      });
    }

    case "setCustomField": {
      // The field decides the column and validates the value. Inferring either
      // from the JavaScript type of `op.to` — what this did before — writes a
      // number into value_num on a text field, where no filter will ever find
      // it again (D-042).
      const field = await loadField(op.fieldId, client);
      const column = fieldValueColumn(field);
      const value = parseFieldValue(field, op.to);

      // jsonb wants a JSON string; handing node-postgres a JS array gets it
      // encoded as a Postgres array literal instead, which the column rejects.
      const param = column === "value_json" && value !== null ? JSON.stringify(value) : value;

      // Upsert: a task may have no row for this field yet. The other typed
      // columns are cleared in the same statement, so a row always holds
      // exactly one value — a field whose type was changed cannot leave a stale
      // number sitting in value_num where a later report would still find it.
      const cleared = VALUE_COLUMNS.filter((c) => c !== column)
        .map((c) => `${c} = NULL`)
        .join(", ");

      await client.query(
        `INSERT INTO field_values (task_id, field_id, ${column}, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (task_id, field_id)
         DO UPDATE SET ${column} = EXCLUDED.${column}, ${cleared}, updated_at = now()`,
        [op.taskId, op.fieldId, param],
      );

      const meta = await taskMeta(client, op.taskId);
      return await logActivity(client, heard, {
        op,
        actorId,
        workspaceId: meta.workspace_id,
        listId: meta.home_list_id,
        field: op.fieldId,
        oldValue: op.from,
        newValue: op.to,
      });
    }

    case "addRelation":
    case "removeRelation": {
      const target = RELATION_TABLES[op.relation];
      if (!target) throw new MutationRejected(`Unknown relation: ${op.relation}`);

      if (op.kind === "addRelation") {
        // Idempotent: adding an assignee twice is a no-op, not an error. The
        // client may retry an optimistic write.
        await client.query(
          `INSERT INTO ${target.table} (task_id, ${target.column})
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [op.taskId, op.targetId],
        );
      } else {
        await client.query(
          `DELETE FROM ${target.table} WHERE task_id = $1 AND ${target.column} = $2`,
          [op.taskId, op.targetId],
        );
      }

      const meta = await taskMeta(client, op.taskId);
      return await logActivity(client, heard, {
        op,
        actorId,
        workspaceId: meta.workspace_id,
        listId: meta.home_list_id,
        field: op.relation,
        oldValue: op.kind === "removeRelation" ? op.targetId : null,
        newValue: op.kind === "addRelation" ? op.targetId : null,
      });
    }

    case "createTask": {
      const v = op.values as Record<string, unknown>;

      const result = await client.query(
        `INSERT INTO tasks
           (id, workspace_id, home_list_id, space_id, folder_id, name,
            status_id, priority, position, created_by)
         SELECT $1, c.workspace_id, c.id,
                $3::uuid, $4::uuid, $5, $6::uuid, $7::int, $8, $9
         FROM containers c WHERE c.id = $2
         RETURNING workspace_id, home_list_id`,
        [
          op.taskId,
          op.listId,
          v.spaceId,
          v.folderId ?? null,
          v.name,
          v.statusId ?? null,
          v.priority ?? null,
          v.position,
          actorId,
        ],
      );

      const row = requireRow(result.rows[0], op.taskId);

      // Home-list membership is a row in task_lists too (D-010), written in the
      // same transaction so the two placements can never disagree.
      await client.query(
        `INSERT INTO task_lists (task_id, list_id, is_home, position)
         VALUES ($1, $2, true, $3)`,
        [op.taskId, op.listId, v.position],
      );

      return await logActivity(client, heard, {
        op,
        actorId,
        workspaceId: row.workspace_id,
        listId: row.home_list_id,
        field: null,
        oldValue: null,
        newValue: { name: v.name },
      });
    }

    case "archiveTask":
    case "restoreTask": {
      const result = await client.query(
        `UPDATE tasks SET archived_at = $2, updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING workspace_id, home_list_id`,
        [op.taskId, op.kind === "archiveTask" ? new Date() : null],
      );

      const row = requireRow(result.rows[0], op.taskId);
      return await logActivity(client, heard, {
        op,
        actorId,
        workspaceId: row.workspace_id,
        listId: row.home_list_id,
        field: "archived_at",
        oldValue: null,
        newValue: op.kind === "archiveTask",
      });
    }

    /**
     * Comments go through here for the same reason everything else does: this
     * stays the only thing that writes, so the activity row and the inverse
     * come from the same place rather than from a comment service that has to
     * remember (D-083).
     *
     * `objectKind`/`objectId` on the row name the *comment's* subject; the
     * activity row names the **task**, because "what happened to this task" is
     * the question the feed answers and a comment appearing is one of the
     * answers.
     */
    case "createComment": {
      const meta = await taskMeta(client, op.taskId);
      const body = parseStoredDoc(op.body);
      if (!body) throw new MutationRejected("That comment body is not a valid document");

      // A reply must be on the same task, or a thread could be grafted onto
      // another task's comment and appear in two places at once.
      if (op.parentId) {
        const parent = await client.query<{ object_id: string }>(
          `SELECT object_id FROM comments WHERE id = $1 AND deleted_at IS NULL`,
          [op.parentId],
        );
        if (!parent.rows[0]) throw new MutationRejected("That comment no longer exists");
        if (parent.rows[0].object_id !== op.taskId) {
          throw new MutationRejected("A reply must be on the same task as the comment it answers");
        }

        // One level (D-083): replying to a reply attaches to its parent rather
        // than nesting, so a thread has a bottom.
        const grandparent = await client.query<{ parent_id: string | null }>(
          `SELECT parent_id FROM comments WHERE id = $1`,
          [op.parentId],
        );
        if (grandparent.rows[0]?.parent_id) {
          throw new MutationRejected("Replies do not nest further than one level");
        }
      }

      await client.query(
        `INSERT INTO comments (id, workspace_id, object_kind, object_id, parent_id, author_id, body)
         VALUES ($1, $2, 'task', $3, $4, $5, $6)`,
        [op.commentId, meta.workspace_id, op.taskId, op.parentId, actorId, JSON.stringify(body)],
      );

      return await logActivity(client, heard, {
        op,
        actorId,
        workspaceId: meta.workspace_id,
        listId: meta.home_list_id,
        field: op.commentId,
        oldValue: null,
        newValue: renderPlain(body),
      });
    }

    case "deleteComment":
    case "restoreComment": {
      const meta = await taskMeta(client, op.taskId);

      // Scoped to the task the operation names, not just to the comment id: an
      // operation arriving from a client carries both, and writing to a comment
      // whose task is not the one that was authorized would make the check in
      // D-080 mean nothing.
      const result = await client.query(
        `UPDATE comments SET deleted_at = $1, updated_at = now()
         WHERE id = $2 AND object_kind = 'task' AND object_id = $3`,
        [op.kind === "deleteComment" ? new Date() : null, op.commentId, op.taskId],
      );

      if (result.rowCount === 0) throw new MutationRejected("That comment no longer exists");

      return await logActivity(client, heard, {
        op,
        actorId,
        workspaceId: meta.workspace_id,
        listId: meta.home_list_id,
        field: op.commentId,
        oldValue: null,
        newValue: op.kind === "deleteComment",
      });
    }

    case "editComment": {
      const meta = await taskMeta(client, op.taskId);
      const body = parseStoredDoc(op.to);
      if (!body) throw new MutationRejected("That comment body is not a valid document");

      const result = await client.query(
        `UPDATE comments SET body = $1, updated_at = now()
         WHERE id = $2 AND object_kind = 'task' AND object_id = $3 AND deleted_at IS NULL`,
        [JSON.stringify(body), op.commentId, op.taskId],
      );

      if (result.rowCount === 0) throw new MutationRejected("That comment no longer exists");

      return await logActivity(client, heard, {
        op,
        actorId,
        workspaceId: meta.workspace_id,
        listId: meta.home_list_id,
        field: op.commentId,
        oldValue: renderPlain(parseStoredDoc(op.from) ?? { type: "doc", content: [] }),
        newValue: renderPlain(body),
      });
    }

    case "setDescription": {
      const meta = await taskMeta(client, op.taskId);

      // An empty document is stored as NULL rather than as `{"content":[]}`,
      // so "has a description" is a question the column answers on its own.
      const to = op.to === null ? null : parseStoredDoc(op.to);
      if (op.to !== null && to === null) {
        throw new MutationRejected("That description is not a valid document");
      }
      const stored = to === null || to.content.length === 0 ? null : JSON.stringify(to);

      await client.query(`UPDATE tasks SET description = $1, updated_at = now() WHERE id = $2`, [
        stored,
        op.taskId,
      ]);

      return await logActivity(client, heard, {
        op,
        actorId,
        workspaceId: meta.workspace_id,
        listId: meta.home_list_id,
        field: "description",
        oldValue: op.from === null ? null : renderPlain(op.from),
        newValue: to === null ? null : renderPlain(to),
      });
    }

    /**
     * Tracked time, through the same door as everything else (D-093).
     *
     * A timer service with its own INSERT would work and would be the second
     * writer — no activity row, no undo, no nudge, and nothing to notice any of
     * the three were missing. The cost of coming through here is that starting
     * a timer writes a log row, which is exactly what makes "who tracked what,
     * when" answerable from the table that already answers every other version
     * of that question.
     */
    case "createTimeEntry": {
      const meta = await taskMeta(client, op.taskId);

      // Validated here as well as in the action, because the action is not the
      // only caller: undo replays operations straight from a client, and the
      // worker will apply them with no form in front of it at all.
      validateTimeEntry(op.values);
      if (op.values.endedAt === null) {
        await requireNoOtherTimer(client, op.userId, op.entryId);
      }

      await client.query(
        `INSERT INTO time_entries
           (id, workspace_id, task_id, user_id, started_at, ended_at, duration_ms,
            description, is_billable)
         VALUES ($1, $2, $3, $4, $5, $6, ${duration("$6", "$5")}, $7, $8)`,
        [
          op.entryId,
          meta.workspace_id,
          op.taskId,
          op.userId,
          op.values.startedAt,
          op.values.endedAt,
          op.values.description,
          op.values.isBillable,
        ],
      );

      return await logActivity(client, heard, {
        op,
        actorId,
        workspaceId: meta.workspace_id,
        listId: meta.home_list_id,
        field: op.entryId,
        oldValue: null,
        newValue: loggedMs(op.values),
        timerUserId: op.userId,
      });
    }

    case "setTimeEntry": {
      const meta = await taskMeta(client, op.taskId);
      validateTimeEntry(op.to);

      // Scoped to the task the operation names, not just to the entry id — the
      // same rule as the comment operations, and for the same reason: an
      // operation arriving from a client carries both, and writing to an entry
      // whose task is not the one that was authorized would make the check that
      // authorized it mean nothing.
      const owner = await client.query<{ user_id: string }>(
        `SELECT user_id FROM time_entries WHERE id = $1 AND task_id = $2`,
        [op.entryId, op.taskId],
      );
      const userId = owner.rows[0]?.user_id;
      if (!userId) throw new MutationRejected("That time entry no longer exists");

      // Undoing a stop starts it running again, which is the one path that can
      // produce a second running timer without anybody having asked for one.
      if (op.to.endedAt === null) {
        await requireNoOtherTimer(client, userId, op.entryId);
      }

      await client.query(
        `UPDATE time_entries
         SET started_at = $3, ended_at = $4, duration_ms = ${duration("$4", "$3")},
             description = $5, is_billable = $6
         WHERE id = $1 AND task_id = $2`,
        [
          op.entryId,
          op.taskId,
          op.to.startedAt,
          op.to.endedAt,
          op.to.description,
          op.to.isBillable,
        ],
      );

      return await logActivity(client, heard, {
        op,
        actorId,
        workspaceId: meta.workspace_id,
        listId: meta.home_list_id,
        field: op.entryId,
        oldValue: loggedMs(op.from),
        newValue: loggedMs(op.to),
        timerUserId: userId,
      });
    }

    /**
     * The only hard delete in the executor.
     *
     * Everything else is archived so that undo has something to restore
     * (D-015), and `time_entries` has no column to archive into. The operation
     * carries the row instead, so its inverse is a `createTimeEntry` with the
     * same id — undo restores *that* entry rather than one resembling it, and
     * doing it twice is idempotent because the id comes back with it.
     */
    case "deleteTimeEntry": {
      const meta = await taskMeta(client, op.taskId);

      const result = await client.query(
        `DELETE FROM time_entries WHERE id = $1 AND task_id = $2`,
        [op.entryId, op.taskId],
      );
      if (result.rowCount === 0) throw new MutationRejected("That time entry no longer exists");

      return await logActivity(client, heard, {
        op,
        actorId,
        workspaceId: meta.workspace_id,
        listId: meta.home_list_id,
        field: op.entryId,
        oldValue: loggedMs(op.values),
        newValue: null,
        timerUserId: op.userId,
      });
    }

    default: {
      const exhaustive: never = op;
      throw new MutationRejected(`Unhandled operation: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * The duration expression with its two placeholders bound.
 *
 * A function rather than a template at each call site so the ended/started
 * order cannot be transposed in one of the two statements that use it — which
 * would produce negative durations on exactly one write path and pass every
 * check that only exercised the other.
 */
function duration(ended: string, started: string): string {
  return DURATION_MS.replaceAll("$ENDED", ended).replaceAll("$STARTED", started);
}

/**
 * What the activity log records for a time entry: how long it was.
 *
 * Null while it runs, because a timer that has just started has tracked
 * nothing, and a zero in the log would read as a fact rather than as an absence.
 */
function loggedMs(values: TimeEntryValues): number | null {
  if (values.endedAt === null) return null;
  return new Date(values.endedAt).getTime() - new Date(values.startedAt).getTime();
}

/**
 * At most one running entry per person — the rule the table comment states.
 *
 * A unique partial index holds it (D-094); this exists so the refusal is a
 * sentence rather than a constraint-violation error, and so the check reads
 * where the rule applies. In normal use it never fires: starting a timer stops
 * the running one in the same batch, so the only things that reach here are a
 * race between two tabs and a bug.
 */
async function requireNoOtherTimer(
  client: PoolClient,
  userId: string,
  entryId: string,
): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM time_entries
     WHERE user_id = $1 AND ended_at IS NULL AND id <> $2
     LIMIT 1`,
    [userId, entryId],
  );

  if (result.rowCount !== 0) {
    throw new MutationRejected("A timer is already running. Stop it before starting another.");
  }
}

interface TaskMeta {
  workspace_id: string;
  home_list_id: string;
}

function requireRow(row: TaskMeta | undefined, taskId: string): TaskMeta {
  if (!row) {
    throw new MutationRejected(`Task not found or already deleted: ${taskId}`);
  }
  return row;
}

async function taskMeta(client: PoolClient, taskId: string): Promise<TaskMeta> {
  const result = await client.query<TaskMeta>(
    `SELECT workspace_id, home_list_id FROM tasks WHERE id = $1 AND deleted_at IS NULL`,
    [taskId],
  );
  return requireRow(result.rows[0], taskId);
}

interface LogArgs {
  op: Operation;
  actorId: string;
  workspaceId: string;
  listId: string;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  /**
   * Whose timer this changed, for the nudge (D-098).
   *
   * Passed rather than derived from the operation, because `setTimeEntry` does
   * not carry a user id — the executor had to read the row to find out, and
   * making the operation carry one would mean a client-supplied claim about
   * whose time an entry is.
   */
  timerUserId?: string;
}

/**
 * Returns the id it wrote, so a notification can point at the thing that caused
 * it — which is what makes "why am I being told this" a question with an answer.
 *
 * **It records what to announce rather than announcing it** (D-099). The
 * broadcast used to happen here, because every operation passes through this
 * function and so a new operation could not forget to send one (D-090). It has
 * moved up to `applyOperations`, which every operation also passes through and
 * which is the first place that knows the part of a nudge worth carrying: who
 * the fan-out told. `NOTIFY` is still emitted inside the transaction, so a
 * rolled-back batch still announces nothing.
 */
async function logActivity(
  client: PoolClient,
  heard: Announcements,
  args: LogArgs,
): Promise<Logged> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO activity
       (workspace_id, actor_id, object_kind, object_id, verb, field, old_value, new_value, list_id)
     VALUES ($1, $2, 'task', $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      args.workspaceId,
      args.actorId,
      args.op.taskId,
      activityVerb(args.op),
      args.field,
      args.oldValue === undefined ? null : JSON.stringify(args.oldValue),
      args.newValue === undefined ? null : JSON.stringify(args.newValue),
      args.listId,
    ],
  );

  heard.touch(args.workspaceId, args.listId);
  if (args.timerUserId) heard.timer(args.listId, args.timerUserId);

  return {
    id: BigInt(result.rows[0]!.id),
    workspaceId: args.workspaceId,
    listId: args.listId,
  };
}
