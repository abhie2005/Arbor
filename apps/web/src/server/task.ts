import "server-only";

import {
  FIELD_TYPE_META,
  type FieldPlacement,
  type Permission,
  type StatusGroup,
} from "@arbor/core";
import { fieldsAvailableOn, listTaskTypes, pool, resolveStatusSetFor, taskAccess } from "@arbor/db";

import type { StatusRow } from "./views";

/**
 * One task, for the detail page.
 *
 * **A view compiles "which rows"; this already knows the row.** So there is no
 * compiler here and that is not a hole in the bet (D-032) — the compiler
 * answers a question this page is not asking. What it *does* borrow is the
 * thing the compiler was doing for free on every other screen: the
 * `access_index` join. Without it the page would happily render a task in a
 * private list to anyone holding a link, which is precisely what a URL makes
 * possible for the first time.
 *
 * Everything else is deliberately not new. Which custom fields a task shows is
 * `fieldsAvailableOn` — the same inheritance and task-type scoping the settings
 * screen uses. Which statuses it can move between is `resolveStatusSetFor` —
 * the same walk every renderer does. A detail page inventing either would be a
 * second answer to a question that already has one.
 */

/** What the viewer holds decides whether a control is a control or a value. */
export type Editability = "editable" | "read-only";

export interface DetailField {
  fieldId: string;
  name: string;
  type: FieldPlacement["type"];
  typeConfig: Record<string, unknown>;
  value: unknown;
  editable: Editability;
  /** Why not, when it is read-only — shown rather than left to be guessed. */
  reason?: string;
}

export interface Person {
  id: string;
  name: string;
}

export interface Subtask {
  id: string;
  key: string | null;
  name: string;
  statusGroup: StatusGroup | null;
}

export interface TaskDetail {
  id: string;
  key: string | null;
  name: string;
  statusId: string | null;
  priority: number | null;
  dueAt: string | null;
  dueHasTime: boolean;
  startAt: string | null;
  startHasTime: boolean;
  taskTypeId: string | null;
  parent: { id: string; key: string | null; name: string } | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  createdByName: string | null;

  workspaceId: string;
  workspaceName: string;
  listId: string;
  listName: string;
  folderName: string;
  spaceName: string;
  listTaskCount: number;

  /** What the viewer holds on the home list — `edit` or better means controls. */
  permission: Permission;
  canEdit: boolean;

  statuses: StatusRow[];
  taskTypes: Person[];
  people: Person[];
  assigneeIds: string[];
  watcherIds: string[];
  fields: DetailField[];
  subtasks: Subtask[];
}

/**
 * Types with one obvious control, and therefore editable here.
 *
 * The rest render as values with a note saying why. That is the same rule as
 * the table's unsortable headers (D-065): a control that looks live and does
 * nothing is worse than a value that explains itself. Multi-valued types need
 * a picker that does not exist yet; derived types are the worker's to compute
 * and `parseFieldValue` refuses them at the boundary anyway.
 */
const EDITABLE_TYPES = new Set<FieldPlacement["type"]>([
  "short_text",
  "text",
  "number",
  "currency",
  "url",
  "email",
  "phone",
  "checkbox",
  "date",
  "drop_down",
  "rating",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turns whatever is in the URL into a task id the viewer may see.
 *
 * D-031 chose the human key — `/t/ENG-402` is what someone pastes into a
 * message. But `tasks.key` is nullable: a task created outside a space with a
 * prefix has none, and it still needs an address. So the segment is resolved as
 * a key first and as an id second, which makes both work without two routes.
 *
 * **The resolution is not permission-scoped and does not need to be.** It only
 * turns a string into a candidate id; `taskAccess` is what decides whether the
 * viewer sees anything, and it is the only thing that returns.
 */
async function resolveId(segment: string): Promise<string | null> {
  const decoded = decodeURIComponent(segment);

  const byKey = await pool().query<{ id: string }>(
    `SELECT id FROM tasks WHERE key = $1 AND deleted_at IS NULL LIMIT 1`,
    [decoded],
  );
  if (byKey.rows[0]) return byKey.rows[0].id;

  return UUID_RE.test(decoded) ? decoded : null;
}

interface TaskRow {
  id: string;
  key: string | null;
  name: string;
  status_id: string | null;
  priority: number | null;
  due_at: Date | null;
  due_has_time: boolean;
  start_at: Date | null;
  start_has_time: boolean;
  task_type_id: string | null;
  parent_task_id: string | null;
  created_at: Date | null;
  updated_at: Date | null;
  completed_at: Date | null;
  archived_at: Date | null;
  created_by_name: string | null;
  workspace_id: string;
  workspace_name: string;
  home_list_id: string;
  list_name: string;
  folder_name: string | null;
  space_name: string | null;
}

const iso = (value: Date | null) => (value === null ? null : value.toISOString());

/**
 * Null means "there is nothing here for you", and says nothing about which of
 * the three reasons applies — no such key, deleted, or not yours. The page
 * renders the same thing for all three (D-080).
 */
export async function loadTask(segment: string, viewerId: string): Promise<TaskDetail | null> {
  const taskId = await resolveId(segment);
  if (!taskId) return null;

  const access = await taskAccess(taskId, viewerId);
  if (!access) return null;

  const connection = pool();

  const result = await connection.query<TaskRow>(
    `SELECT t.id, t.key, t.name, t.status_id, t.priority,
            t.due_at, t.due_has_time, t.start_at, t.start_has_time,
            t.task_type_id, t.parent_task_id,
            t.created_at, t.updated_at, t.completed_at, t.archived_at,
            cu.name AS created_by_name,
            w.id AS workspace_id, w.name AS workspace_name,
            l.id AS home_list_id, l.name AS list_name,
            f.name AS folder_name, sp.name AS space_name
     FROM tasks t
     JOIN workspaces w ON w.id = t.workspace_id
     JOIN containers l ON l.id = t.home_list_id
     -- The kind test matters: a list can sit straight under a space, and
     -- without it the space matches as the folder too, so the breadcrumb
     -- reads "Founders > Founders > Hiring".
     LEFT JOIN containers f  ON f.id = l.parent_id AND f.kind = 'folder'
     LEFT JOIN containers sp ON sp.id = COALESCE(f.parent_id, l.parent_id)
     LEFT JOIN users cu ON cu.id = t.created_by
     WHERE t.id = $1`,
    [taskId],
  );

  const row = result.rows[0];
  if (!row) return null;

  const [statusSet, placements, taskTypes, people, relations, values, subtasks, parent, listCount] =
    await Promise.all([
      resolveStatusSetFor(row.workspace_id, row.home_list_id, connection),
      fieldsAvailableOn(row.workspace_id, row.home_list_id, row.task_type_id, connection),
      listTaskTypes(row.workspace_id, connection),
      connection.query<Person>(
        `SELECT id, name FROM users WHERE deactivated_at IS NULL ORDER BY name`,
      ),
      connection.query<{ user_id: string; kind: string }>(
        `SELECT user_id, 'assignee' AS kind FROM task_assignees WHERE task_id = $1
         UNION ALL
         SELECT user_id, 'watcher'  AS kind FROM task_watchers  WHERE task_id = $1`,
        [taskId],
      ),
      connection.query<{
        field_id: string;
        value_text: string | null;
        value_num: string | null;
        value_date: Date | null;
        value_bool: boolean | null;
        value_json: unknown;
      }>(
        `SELECT field_id, value_text, value_num, value_date, value_bool, value_json
         FROM field_values WHERE task_id = $1`,
        [taskId],
      ),
      // Subtasks are the one thing on this page that exists nowhere else in the
      // UI: the list hides them (`showSubtasks: 3`) and the board promotes them
      // to top-level cards, so until now a subtask could be created and never
      // seen as a child of anything.
      connection.query<{ id: string; key: string | null; name: string; group: StatusGroup | null }>(
        `SELECT t.id, t.key, t.name, s.group
         FROM tasks t LEFT JOIN statuses s ON s.id = t.status_id
         WHERE t.parent_task_id = $1 AND t.deleted_at IS NULL
         ORDER BY t.position`,
        [taskId],
      ),
      row.parent_task_id
        ? connection.query<{ id: string; key: string | null; name: string }>(
            `SELECT id, key, name FROM tasks WHERE id = $1`,
            [row.parent_task_id],
          )
        : null,
      connection.query<{ n: string }>(
        `SELECT count(*) AS n FROM tasks
         WHERE home_list_id = $1 AND deleted_at IS NULL AND archived_at IS NULL`,
        [row.home_list_id],
      ),
    ]);

  const byField = new Map(values.rows.map((v) => [v.field_id, v]));

  const fields: DetailField[] = placements
    .filter((placement) => !placement.archived)
    .map((placement) => {
      const stored = byField.get(placement.id);
      const meta = FIELD_TYPE_META[placement.type];
      const editable = EDITABLE_TYPES.has(placement.type);

      return {
        fieldId: placement.id,
        name: placement.name,
        type: placement.type,
        typeConfig: (placement.typeConfig ?? {}) as Record<string, unknown>,
        value: stored ? valueOf(placement, stored) : null,
        editable: editable ? "editable" : "read-only",
        reason: editable
          ? undefined
          : meta?.derived
            ? `${meta.label} is computed by the system`
            : `${meta?.label ?? placement.type} is not editable here yet`,
      };
    });

  return {
    id: row.id,
    key: row.key,
    name: row.name,
    statusId: row.status_id,
    priority: row.priority,
    dueAt: iso(row.due_at),
    dueHasTime: row.due_has_time,
    startAt: iso(row.start_at),
    startHasTime: row.start_has_time,
    taskTypeId: row.task_type_id,
    parent: parent?.rows[0] ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: iso(row.completed_at),
    archivedAt: iso(row.archived_at),
    createdByName: row.created_by_name,

    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    listId: row.home_list_id,
    listName: row.list_name,
    // Empty rather than the space's name: a list directly under a space has no
    // folder, and repeating the space there reads as "Founders › Founders".
    folderName: row.folder_name ?? "",
    spaceName: row.space_name ?? row.list_name,
    listTaskCount: Number(listCount.rows[0]?.n ?? 0),

    permission: access.permission,
    canEdit: access.permission === "edit" || access.permission === "manage",

    statuses: statusSet.set.statuses.map((status) => ({
      id: status.id,
      name: status.name,
      group: status.group,
      color: status.color,
    })),
    taskTypes: taskTypes.map((type) => ({ id: type.id, name: type.name })),
    people: people.rows,
    assigneeIds: relations.rows.filter((r) => r.kind === "assignee").map((r) => r.user_id),
    watcherIds: relations.rows.filter((r) => r.kind === "watcher").map((r) => r.user_id),
    fields,
    subtasks: subtasks.rows.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      statusGroup: s.group,
    })),
  };
}

/**
 * The one typed column this field uses, read back out.
 *
 * `field_values` holds a row per (task, field) with exactly one column
 * populated, chosen by the field's type (D-013). Reading all of them and
 * picking whichever is non-null would work until a type change left a stale
 * value behind — which is exactly the case `setCustomField` clears on write,
 * and this is the read that has to agree with it.
 */
function valueOf(
  placement: FieldPlacement,
  stored: {
    value_text: string | null;
    value_num: string | null;
    value_date: Date | null;
    value_bool: boolean | null;
    value_json: unknown;
  },
): unknown {
  switch (FIELD_TYPE_META[placement.type]?.column) {
    case "value_text":
      return stored.value_text;
    case "value_num":
      return stored.value_num === null ? null : Number(stored.value_num);
    case "value_date":
      return stored.value_date === null ? null : stored.value_date.toISOString();
    case "value_bool":
      return stored.value_bool;
    case "value_json":
      return stored.value_json;
    default:
      // `byResultType` — a derived field. Nothing computes these yet, and this
      // page shows them as empty rather than guessing at a column.
      return null;
  }
}
