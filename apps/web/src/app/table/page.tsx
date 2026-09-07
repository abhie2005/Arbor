import { AppShell, FooterNote, LoadFailure, chromeFrom } from "@/components/app-shell";
import { ColumnMenu } from "@/components/column-menu";
import { FilterBar } from "@/components/filter-bar";
import { TaskTable, type TableRowData } from "@/components/task-table";
import { ViewTabs } from "@/components/view-tabs";
import { getCurrentUser, listSwitchableUsers } from "@/server/auth";
import { cellsFor } from "@/server/cells";
import { loadFilterOptions, loadView } from "@/server/views";
import { requireWorkspace } from "@/server/workspace";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The table renderer.
 *
 * The third renderer over the same compiled view, and the first to read the
 * `columns` half of a definition — which is the whole reason it was next. It
 * needed no compiler change: the query it runs is the one the list runs, and
 * the values its columns need are fetched for the page it is showing (D-062).
 *
 * Two overrides. `showSubtasks: 1` promotes subtasks to rows of their own,
 * because a table is a flat sequence and there is nowhere for a nested row to
 * go — the same reason the board gives. And `grouping: none`, because a
 * grouped table is a renderer feature this screen does not have yet, and
 * clustering rows by a group nothing draws would order them by a rule the
 * headers do not explain.
 */
export default async function TablePage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string; s?: string; view?: string }>;
}) {
  let viewer: Awaited<ReturnType<typeof getCurrentUser>> = null;
  let data: Awaited<ReturnType<typeof loadView>> = null;
  let options: Awaited<ReturnType<typeof loadFilterOptions>> | null = null;
  let error: string | null = null;

  const { f, s, view } = await searchParams;

  try {
    viewer = await getCurrentUser();
    if (viewer) {
      const workspace = await requireWorkspace();
      [data, options] = await Promise.all([
        loadView({
          viewerId: viewer.id,
          type: "table",
          viewId: view,
          filterParam: f,
          sortParam: s,
          override: {
            grouping: { field: "none", dir: "asc" },
            filters: { showSubtasks: 1 } as never,
          },
        }),
        loadFilterOptions(workspace.id),
      ]);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // Outside the try on purpose: `redirect` signals by throwing, and the catch
  // above would turn it into an error message on a page nobody should reach.
  if (!viewer) redirect("/login");

  if (error || !viewer || !data || !options) {
    // Both parameters are decoded before anything is queried, so either one
    // being present makes a thrown error far likelier to be a bad link than a
    // dead database — and telling someone to start Docker when their URL is
    // wrong sends them to fix the wrong thing.
    const badLink = error !== null && (f !== undefined || s !== undefined);

    return <LoadFailure badLink={badLink} clearTo="/table" error={error} />;
  }

  const users = await listSwitchableUsers();
  const chrome = chromeFrom(data, viewer, users);
  const context = { values: data.values, statuses: data.statuses, assignees: data.assignees };

  const rows: TableRowData[] = data.rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    subtaskCount: data.subtaskCounts.get(row.id) ?? 0,
    statusGroup: row.status_group,
    priority: row.priority,
    cells: cellsFor(row, data.columns, context),
  }));

  return (
    <AppShell chrome={chrome}>
      <ViewTabs
        views={data.views}
        currentViewId={data.viewId}
        definition={data.definition}
        savedDefinition={data.savedDefinition}
        dirty={data.dirty}
      />

      <div className="table-bar">
        <FilterBar
          fields={options.fields}
          values={options}
          filters={data.definition.filters}
        />
        <ColumnMenu
          viewId={data.viewId}
          definition={data.savedDefinition}
          options={options.allColumns}
        />
      </div>

      {/* A column naming a deleted field is dropped rather than thrown
          (D-060) — but silently dropping it would look like missing data,
          so the table says which one went. */}
      {data.droppedColumns.length > 0 ? (
        <p className="table-dropped" role="status">
          {data.droppedColumns.length === 1 ? "One column refers" : `${data.droppedColumns.length} columns refer`}{" "}
          to a field that no longer exists and {data.droppedColumns.length === 1 ? "was" : "were"} left out.
        </p>
      ) : null}

      <TaskTable columns={data.columns} rows={rows} sort={data.definition.sort} />

      <FooterNote>
        {data.rows.length} {data.rows.length === 1 ? "task" : "tasks"} · acting as {viewer.name} · same compiler as the list,
        showing the view&apos;s own columns
      </FooterNote>
    </AppShell>
  );
}
