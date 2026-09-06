import "server-only";

import {
  DEFAULT_VIEW_DEFINITION,
  type FilterableField,
  type ViewDefinition,
  type ViewType,
  compileGroupCounts,
  compileViewQuery,
  filterableFields,
} from "@arbor/core";
import { executeCompiled, loadFieldCatalog, pool } from "@arbor/db";

/**
 * Loading a view.
 *
 * **This is the file that has to stay small.** Every renderer reads through it,
 * and the whole architectural bet is that a renderer is a rendering concern
 * only: the query, the permission scoping, the grouping, and the group counts
 * are the compiler's job and are done once, here. If a renderer ever needs its
 * own query, the bet has been lost and the compiler needs fixing rather than
 * bypassing (D-032).
 *
 * The definition comes from the `views` table, not from a constant, so a board
 * really is "the saved definition with `grouping.field = status`" rather than a
 * hard-coded shape that happens to resemble one.
 */

/** Snake_case because these come straight off the compiler's SELECT list. */
export interface CompiledTaskRow {
  [column: string]: unknown;
  id: string;
  key: string | null;
  name: string;
  priority: number | null;
  parent_task_id: string | null;
  due_at: string | null;
  position: string;
  status_id: string | null;
  status_group: string | null;
  group_key: string | null;
}

export interface StatusRow {
  id: string;
  name: string;
  group: string;
  color: string;
}

export interface ViewContext {
  workspaceId: string;
  workspaceName: string;
  listId: string;
  listName: string;
  folderName: string;
  spaceName: string;
  viewName: string;
  definition: ViewDefinition;
  rows: CompiledTaskRow[];
  /** Counts per group key, from the compiler — a collapsed column still shows one. */
  counts: Map<string, number>;
  statuses: StatusRow[];
  assignees: Map<string, string[]>;
  subtaskCounts: Map<string, number>;
}

interface MetaRow {
  workspace_id: string;
  workspace_name: string;
  list_id: string;
  list_name: string;
  folder_name: string;
  space_name: string;
}

/**
 * The demo list. Replaced by routing on a list id once there is navigation;
 * kept in one place so that change is one edit rather than one per renderer.
 */
async function listMeta(): Promise<MetaRow | undefined> {
  const result = await pool().query<MetaRow>(`
    SELECT w.id AS workspace_id, w.name AS workspace_name,
           l.id AS list_id,      l.name AS list_name,
           f.name AS folder_name, sp.name AS space_name
    FROM workspaces w
    JOIN containers l  ON l.workspace_id = w.id AND l.kind = 'list'
    LEFT JOIN containers f  ON f.id = l.parent_id
    LEFT JOIN containers sp ON sp.id = COALESCE(f.parent_id, l.parent_id)
    WHERE w.slug = 'northwind' AND l.name = 'Sprint 24'
    LIMIT 1
  `);
  return result.rows[0];
}

/**
 * The saved definition for a renderer, or the default.
 *
 * A definition arriving from the database is still untrusted input — it was
 * written by a client at some point — so it goes to the compiler, which
 * resolves every field reference through a closed map and binds every value
 * (D-018). Nothing here needs to sanitize it; nothing here is allowed to
 * interpolate it either.
 */
async function savedDefinition(listId: string, type: ViewType): Promise<{
  name: string;
  definition: ViewDefinition;
}> {
  const result = await pool().query<{ name: string; definition: ViewDefinition }>(
    `SELECT name, definition FROM views
     WHERE parent_id = $1 AND type = $2
     ORDER BY position LIMIT 1`,
    [listId, type],
  );

  const row = result.rows[0];
  return {
    name: row?.name ?? type,
    definition: row?.definition ?? DEFAULT_VIEW_DEFINITION,
  };
}

export async function loadView(
  viewerId: string,
  type: ViewType,
  /** Renderer-specific overrides — a board always groups, whatever was saved. */
  override: Partial<ViewDefinition> = {},
): Promise<ViewContext | null> {
  const meta = await listMeta();
  if (!meta) return null;

  const connection = pool();
  const saved = await savedDefinition(meta.list_id, type);
  const definition: ViewDefinition = { ...saved.definition, ...override };

  const options = {
    workspaceId: meta.workspace_id,
    viewerId,
    scope: { kind: "list", id: meta.list_id } as const,
    definition,
    // Always supplied: a saved definition may filter or sort on a custom field,
    // and the compiler refuses to guess what type it is (D-042).
    fields: await loadFieldCatalog(meta.workspace_id, connection),
  };

  const rows = await executeCompiled<CompiledTaskRow>(compileViewQuery(options), connection);

  const counts = new Map<string, number>();
  if (definition.grouping.field !== "none") {
    const grouped = await connection.query<{ group_key: string | null; count: number }>(
      compileGroupCounts(options).text,
      compileGroupCounts(options).params,
    );
    for (const row of grouped.rows) counts.set(row.group_key ?? "none", Number(row.count));
  }

  const statuses = await connection.query<StatusRow>(
    `SELECT st.id, st.name, st."group", st.color FROM statuses st
     JOIN status_sets ss ON ss.id = st.status_set_id
     WHERE ss.workspace_id = $1 ORDER BY st.position`,
    [meta.workspace_id],
  );

  const assigneeRows = await connection.query<{ task_id: string; name: string }>(
    `SELECT ta.task_id, u.name FROM task_assignees ta JOIN users u ON u.id = ta.user_id`,
  );
  const assignees = new Map<string, string[]>();
  for (const row of assigneeRows.rows) {
    assignees.set(row.task_id, [...(assignees.get(row.task_id) ?? []), row.name]);
  }

  const subRows = await connection.query<{ parent_task_id: string; n: string }>(
    `SELECT parent_task_id, COUNT(*) AS n FROM tasks
     WHERE parent_task_id IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL
     GROUP BY parent_task_id`,
  );

  return {
    workspaceId: meta.workspace_id,
    workspaceName: meta.workspace_name,
    listId: meta.list_id,
    listName: meta.list_name,
    folderName: meta.folder_name,
    spaceName: meta.space_name,
    viewName: saved.name,
    definition,
    rows,
    counts,
    statuses: statuses.rows,
    assignees,
    subtaskCounts: new Map(subRows.rows.map((r) => [r.parent_task_id, Number(r.n)])),
  };
}

export interface FilterOptions {
  fields: FilterableField[];
  statuses: { id: string; name: string; group: string; color: string }[];
  statusGroups: { id: string; name: string }[];
  priorities: { id: string; name: string }[];
  users: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  taskTypes: { id: string; name: string }[];
}

/**
 * Everything the filter bar needs to build menus that cannot produce a
 * rejected filter.
 *
 * The field list comes from @arbor/core, so the menu and the compiler's
 * validation are the same knowledge (D-054). The rest is the value side: a
 * status filter needs statuses, an assignee filter needs people. Loaded in one
 * pass because a filter bar with five round trips feels broken even when it is
 * correct.
 */
export async function loadFilterOptions(workspaceId: string): Promise<FilterOptions> {
  const connection = pool();

  const [catalog, fieldRows, statuses, users, tags, taskTypes] = await Promise.all([
    loadFieldCatalog(workspaceId, connection),
    connection.query<{ id: string; name: string; archived_at: Date | null }>(
      `SELECT id, name, archived_at FROM fields WHERE workspace_id = $1 ORDER BY position`,
      [workspaceId],
    ),
    connection.query<{ id: string; name: string; group: string; color: string }>(
      `SELECT st.id, st.name, st."group", st.color FROM statuses st
       JOIN status_sets ss ON ss.id = st.status_set_id
       WHERE ss.workspace_id = $1 ORDER BY st.position`,
      [workspaceId],
    ),
    connection.query<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE deactivated_at IS NULL ORDER BY created_at`,
    ),
    connection.query<{ id: string; name: string }>(
      `SELECT id, name FROM tags WHERE workspace_id = $1 ORDER BY name`,
      [workspaceId],
    ),
    connection.query<{ id: string; name: string }>(
      `SELECT id, name FROM task_types WHERE workspace_id = $1 ORDER BY name`,
      [workspaceId],
    ),
  ]);

  const archived = new Set(
    fieldRows.rows.filter((row) => row.archived_at !== null).map((row) => row.id),
  );
  const names = new Map(fieldRows.rows.map((row) => [row.id, row.name]));

  return {
    fields: filterableFields(catalog, archived, names),
    statuses: statuses.rows,
    statusGroups: [
      { id: "not_started", name: "Not started" },
      { id: "active", name: "Active" },
      { id: "done", name: "Done" },
      { id: "closed", name: "Closed" },
    ],
    // A fixed scale, unlike status (D-014) — so it is a constant, not a query.
    priorities: [
      { id: "1", name: "Urgent" },
      { id: "2", name: "High" },
      { id: "3", name: "Normal" },
      { id: "4", name: "Low" },
    ],
    users: users.rows,
    tags: tags.rows,
    taskTypes: taskTypes.rows,
  };
}
