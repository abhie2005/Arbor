import "server-only";

import {
  DEFAULT_VIEW_DEFINITION,
  type FilterGroup,
  type FilterableField,
  type ViewDefinition,
  type ViewType,
  compileGroupCounts,
  compileViewQuery,
  decodeFilters,
  filterableFields,
} from "@arbor/core";
import { executeCompiled, listViews, loadFieldCatalog, pool } from "@arbor/db";

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
  /** The saved view being rendered, so the tab strip can mark it current. */
  viewId: string | null;
  workspaceId: string;
  workspaceName: string;
  listId: string;
  listName: string;
  folderName: string;
  spaceName: string;
  viewName: string;
  /**
   * True when the URL asks for a filter the saved view does not have.
   *
   * Computed here rather than in the component because only this side knows
   * which parts of a definition a *renderer* overrides — a board always groups
   * by status and the list always hides subtasks, and neither is an unsaved
   * change the user made.
   */
  dirty: boolean;
  /** Every view on this container the viewer can see, for the tab strip. */
  views: { id: string; name: string; type: string; isDefault: boolean; personal: boolean }[];
  savedDefinition: ViewDefinition;
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
 * The saved view to render: the one asked for by id, else this container's
 * default, else the first of the right type.
 *
 * A definition arriving from the database is still untrusted input — it was
 * written by a client at some point — so it goes to the compiler, which
 * resolves every field reference through a closed map and binds every value
 * (D-018). Nothing here needs to sanitize it; nothing here is allowed to
 * interpolate it either.
 */
async function savedView(
  listId: string,
  type: ViewType,
  viewerId: string,
  viewId?: string,
): Promise<{ id: string | null; name: string; definition: ViewDefinition }> {
  const result = await pool().query<{ id: string; name: string; definition: ViewDefinition }>(
    `SELECT id, name, definition FROM views
     WHERE parent_id = $1 AND type = $2
       AND (owner_id IS NULL OR owner_id = $3)
       AND ($4::uuid IS NULL OR id = $4)
     ORDER BY is_default DESC, position
     LIMIT 1`,
    [listId, type, viewerId, viewId ?? null],
  );

  const row = result.rows[0];
  return {
    id: row?.id ?? null,
    name: row?.name ?? type,
    definition: row?.definition ?? DEFAULT_VIEW_DEFINITION,
  };
}

export interface LoadViewOptions {
  viewerId: string;
  type: ViewType;
  /** Renderer-specific overrides — a board always groups, whatever was saved. */
  override?: Partial<ViewDefinition>;
  /** Which saved view to open. Defaults to the container's default. */
  viewId?: string;
  /** The raw `?f=` parameter, layered over the saved view's own filters. */
  filterParam?: string;
}

/**
 * The saved view's filters are the base; the URL layers over them.
 *
 * Getting this backwards — decoding against the built-in defaults and passing
 * the result down as an override — means a saved view's filters never apply at
 * all, which is most of the point of saving one.
 */
export async function loadView(options: LoadViewOptions): Promise<ViewContext | null> {
  const { viewerId, type, override = {}, viewId, filterParam } = options;

  const meta = await listMeta();
  if (!meta) return null;

  const connection = pool();
  const [saved, tabs] = await Promise.all([
    savedView(meta.list_id, type, viewerId, viewId),
    listViews(meta.workspace_id, meta.list_id, viewerId, connection),
  ]);

  const baseFilters: FilterGroup = { ...saved.definition.filters, ...(override.filters ?? {}) };
  const filters = decodeFilters(filterParam, baseFilters);
  const definition: ViewDefinition = { ...saved.definition, ...override, filters };

  const compileOptions = {
    workspaceId: meta.workspace_id,
    viewerId,
    scope: { kind: "list", id: meta.list_id } as const,
    definition,
    // Always supplied: a saved definition may filter or sort on a custom field,
    // and the compiler refuses to guess what type it is (D-042).
    fields: await loadFieldCatalog(meta.workspace_id, connection),
  };

  const rows = await executeCompiled<CompiledTaskRow>(
    compileViewQuery(compileOptions),
    connection,
  );

  const counts = new Map<string, number>();
  if (definition.grouping.field !== "none") {
    const grouped = await connection.query<{ group_key: string | null; count: number }>(
      compileGroupCounts(compileOptions).text,
      compileGroupCounts(compileOptions).params,
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
    viewId: saved.id,
    workspaceId: meta.workspace_id,
    workspaceName: meta.workspace_name,
    listId: meta.list_id,
    listName: meta.list_name,
    folderName: meta.folder_name,
    spaceName: meta.space_name,
    viewName: saved.name,
    dirty: saved.id !== null && !sameFilters(filters, saved.definition.filters),
    views: tabs.map((tab) => ({
      id: tab.id,
      name: tab.name,
      type: tab.type,
      isDefault: tab.isDefault,
      personal: tab.ownerId !== null,
    })),
    /** The definition as saved, for comparing against what the URL asks for. */
    savedDefinition: saved.definition,
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


/**
 * Whether the user has changed the filter, ignoring everything they cannot
 * change from the filter bar.
 *
 * Two things make this fiddlier than an equality check, and both were bugs:
 *
 * 1. `showSubtasks` is a renderer override — the list forces 3, the board 1 —
 *    so comparing whole filter objects reports every view as unsaved the
 *    moment it opens.
 * 2. **`JSON.stringify` is not a structural comparison.** It preserves
 *    insertion order, and a definition that has been through Postgres `jsonb`
 *    comes back with its keys reordered. A filter saved as
 *    `{field, op, value}` returns as `{op, field, value}`, so stringifying
 *    both sides reported "unsaved" forever, on a view that had just been
 *    saved successfully.
 *
 * Each condition is therefore reduced to a key built in a fixed order.
 */
function sameFilters(a: FilterGroup, b: FilterGroup): boolean {
  const key = (f: FilterGroup) =>
    [
      f.op ?? "AND",
      f.showClosed === true ? "closed" : "open",
      ...f.conditions.map(
        (c) => `${String(c.field)}\u0000${c.op}\u0000${JSON.stringify(c.value ?? null)}`,
      ),
    ].join("\u0001");

  return key(a) === key(b);
}
