import "server-only";

import {
  type FieldCatalog,
  type ResolvedColumn,
  fieldValueColumn,
} from "@arbor/core";
import { pool } from "@arbor/db";

/**
 * The values a table's columns need that the compiled row does not carry.
 *
 * Two kinds of thing end up here. **Custom field values**, which live in the
 * typed EAV table (D-013) and are one row per (task, field) rather than a
 * column on `tasks`. And **names for ids** — a row holds `task_type_id`, and a
 * cell has to say "Bug".
 *
 * **Why this is a second query and not a wider SELECT.** Projecting a custom
 * field means a correlated subquery per visible column, so a fifteen-column
 * table compiles fifteen of them and the query text changes every time someone
 * shows or hides a column. One `WHERE task_id = ANY(...) AND field_id =
 * ANY(...)` is a single indexed lookup whatever the column count, and its text
 * is identical for every view (D-062).
 *
 * It is safe to run *after* the compiled query rather than as part of it
 * because the task ids it takes have already come out of a permission-scoped
 * result. This file can only ever narrow what the viewer was already allowed
 * to see; it can never widen it. That is the property to preserve if anything
 * here grows — nothing in this file may take an id from anywhere but `rows`.
 */

type Connection = ReturnType<typeof pool>;

export interface TagValue {
  name: string;
  color: string;
}

export interface TaskRef {
  key: string | null;
  name: string;
}

export interface ColumnValues {
  /** taskId → fieldId → the value, already normalized for the wire. */
  custom: Map<string, Map<string, unknown>>;
  tags: Map<string, TagValue[]>;
  watchers: Map<string, string[]>;
  /** userId → display name, for `createdBy` and people-typed custom fields. */
  people: Map<string, string>;
  taskTypes: Map<string, string>;
  containers: Map<string, string>;
  /** Parent tasks and anything a task-typed custom field points at. */
  tasks: Map<string, TaskRef>;
}

const EMPTY: ColumnValues = {
  custom: new Map(),
  tags: new Map(),
  watchers: new Map(),
  people: new Map(),
  taskTypes: new Map(),
  containers: new Map(),
  tasks: new Map(),
};

interface ValueRow {
  task_id: string;
  field_id: string;
  value_text: string | null;
  value_num: number | null;
  value_date: Date | null;
  value_bool: boolean | null;
  value_json: unknown;
}

export interface ValueSourceRow {
  id: string;
  parent_task_id?: string | null;
  created_by?: string | null;
}

/**
 * Runs only the lookups the visible columns actually ask for.
 *
 * The list and the board resolve to columns that need none of this, so they
 * pay for nothing: `loadView` calls this on every render and it returns
 * without touching the database unless a column needs it.
 */
export async function loadColumnValues(
  columns: readonly ResolvedColumn[],
  rows: readonly ValueSourceRow[],
  options: { workspaceId: string; catalog: FieldCatalog; connection?: Connection },
): Promise<ColumnValues> {
  const taskIds = rows.map((row) => row.id);
  const customFieldIds = columns
    .filter((column) => column.custom && column.fieldId)
    .map((column) => column.fieldId as string);

  const has = (test: (column: ResolvedColumn) => boolean) => columns.some(test);
  const needsTags = has((c) => c.kind === "tags");
  const needsWatchers = has((c) => c.ref === "watcher");
  const needsTaskTypes = has((c) => c.kind === "taskType");
  const needsContainers = has((c) => c.kind === "container");
  const needsPeople =
    needsWatchers || has((c) => c.ref === "createdBy") || has((c) => c.custom && c.kind === "users");
  const needsTasks = has((c) => c.kind === "task");

  const wanted =
    customFieldIds.length > 0 ||
    needsTags ||
    needsWatchers ||
    needsTaskTypes ||
    needsContainers ||
    needsPeople ||
    needsTasks;

  if (!wanted || taskIds.length === 0) return EMPTY;

  const db = options.connection ?? pool();
  const { workspaceId, catalog } = options;

  const [valueRows, tagRows, watcherRows, typeRows, containerRows, peopleRows] = await Promise.all([
    customFieldIds.length > 0
      ? db.query<ValueRow>(
          `SELECT task_id, field_id, value_text, value_num, value_date, value_bool, value_json
           FROM field_values
           WHERE task_id = ANY($1::uuid[]) AND field_id = ANY($2::uuid[])`,
          [taskIds, customFieldIds],
        )
      : null,
    needsTags
      ? db.query<{ task_id: string; name: string; color: string }>(
          `SELECT tt.task_id, tg.name, tg.color
           FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id
           WHERE tt.task_id = ANY($1::uuid[])
           ORDER BY tg.name`,
          [taskIds],
        )
      : null,
    needsWatchers
      ? db.query<{ task_id: string; user_id: string }>(
          `SELECT task_id, user_id FROM task_watchers WHERE task_id = ANY($1::uuid[])`,
          [taskIds],
        )
      : null,
    needsTaskTypes
      ? db.query<{ id: string; name: string }>(
          `SELECT id, name FROM task_types WHERE workspace_id = $1`,
          [workspaceId],
        )
      : null,
    needsContainers
      ? db.query<{ id: string; name: string }>(
          `SELECT id, name FROM containers WHERE workspace_id = $1`,
          [workspaceId],
        )
      : null,
    needsPeople
      ? db.query<{ id: string; name: string }>(`SELECT id, name FROM users`)
      : null,
  ]);

  const custom = new Map<string, Map<string, unknown>>();
  for (const row of valueRows?.rows ?? []) {
    const field = catalog.get(row.field_id);
    if (!field) continue;

    // The column comes from the field's declared type, never from which
    // columns happen to be non-null: a task can hold a stale value in the old
    // column after a type change, and reading the first non-null one would
    // show the value the migration replaced (D-045).
    const value = normalize(row[fieldValueColumn(field) as keyof ValueRow]);
    if (value === null) continue;

    const forTask = custom.get(row.task_id) ?? new Map<string, unknown>();
    forTask.set(row.field_id, value);
    custom.set(row.task_id, forTask);
  }

  const people = new Map((peopleRows?.rows ?? []).map((row) => [row.id, row.name]));

  const tags = new Map<string, TagValue[]>();
  for (const row of tagRows?.rows ?? []) {
    tags.set(row.task_id, [...(tags.get(row.task_id) ?? []), { name: row.name, color: row.color }]);
  }

  const watchers = new Map<string, string[]>();
  for (const row of watcherRows?.rows ?? []) {
    const name = people.get(row.user_id);
    if (!name) continue;
    watchers.set(row.task_id, [...(watchers.get(row.task_id) ?? []), name]);
  }

  // Parent tasks, plus whatever a task-typed custom field points at. One query
  // for both: they are the same lookup and the ids all came from rows this
  // viewer was already served.
  const referenced = new Set<string>();
  if (needsTasks) {
    for (const row of rows) if (row.parent_task_id) referenced.add(row.parent_task_id);
    for (const column of columns) {
      if (!column.custom || column.kind !== "task" || !column.fieldId) continue;
      for (const forTask of custom.values()) {
        const value = forTask.get(column.fieldId);
        for (const id of Array.isArray(value) ? value : value ? [value] : []) {
          if (typeof id === "string") referenced.add(id);
        }
      }
    }
  }

  const taskRows =
    referenced.size > 0
      ? await db.query<{ id: string; key: string | null; name: string }>(
          `SELECT id, key, name FROM tasks WHERE id = ANY($1::uuid[])`,
          [[...referenced]],
        )
      : null;

  return {
    custom,
    tags,
    watchers,
    people,
    taskTypes: new Map((typeRows?.rows ?? []).map((row) => [row.id, row.name])),
    containers: new Map((containerRows?.rows ?? []).map((row) => [row.id, row.name])),
    tasks: new Map(
      (taskRows?.rows ?? []).map((row) => [row.id, { key: row.key, name: row.name }]),
    ),
  };
}

/**
 * Dates cross to the client as ISO strings.
 *
 * A `Date` survives the RSC boundary, but every other date on the page is a
 * string off the compiled row, and a cell renderer that has to handle both
 * shapes will eventually handle one of them wrong.
 */
function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}
