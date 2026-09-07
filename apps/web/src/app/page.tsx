import { FilterBar } from "@/components/filter-bar";
import { NewTaskRow } from "@/components/new-task";
import { TaskRow, type TaskRowData } from "@/components/task-row";
import { UndoButton, UndoProvider } from "@/components/undo";
import { UserSwitcher } from "@/components/user-switcher";
import { ViewTabs } from "@/components/view-tabs";
import { getCurrentUser, listSwitchableUsers } from "@/server/auth";
import { loadFilterOptions, loadView } from "@/server/views";
import { requireWorkspace } from "@/server/workspace";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The list renderer.
 *
 * It has no query of its own (D-032): it reads through `loadView`, which reads
 * through the compiler the API uses. A broken compiler is a visibly broken
 * screen, which is the point — the alternative is a demo page that keeps
 * working while the thing it is demonstrating does not.
 *
 * `showSubtasks: 3` is the one override: subtasks are hidden here rather than
 * nested, because nesting is a rendering feature this screen does not have yet
 * and promoting them to top-level rows would misrepresent the list.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ f?: string; view?: string }>;
}) {
  let viewer: Awaited<ReturnType<typeof getCurrentUser>> = null;
  let data: Awaited<ReturnType<typeof loadView>> = null;
  let options: Awaited<ReturnType<typeof loadFilterOptions>> | null = null;
  let error: string | null = null;

  const { f, view } = await searchParams;

  try {
    viewer = await getCurrentUser();
    if (viewer) {
      // The saved view's filters are the base; `?f=` layers over them inside
      // loadView. A filter that will not parse is reported, never silently
      // dropped — an unfiltered list that looks filtered is the same failure
      // shape as D-042.
      const workspace = await requireWorkspace();
      [data, options] = await Promise.all([
        loadView({
          viewerId: viewer.id,
          type: "list",
          viewId: view,
          filterParam: f,
          // Subtasks are hidden here rather than nested: nesting is a rendering
          // feature this screen does not have, and promoting them to top-level
          // rows would misrepresent the list.
          override: { filters: { showSubtasks: 3 } as never },
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
    // A bad filter link is a different failure from a missing database, and
    // saying so is the difference between "fix your link" and "start Docker".
    const badLink = error !== null && f !== undefined;

    return (
      <main className="empty">
        <h2>{badLink ? "That filter link is not valid" : error ? "Could not reach the database" : "No demo workspace yet"}</h2>
        {badLink ? (
          <p>
            <a href="/">Clear the filter</a> and start again.
          </p>
        ) : (
          <>
            <p>Start the local services and seed the demo workspace:</p>
            <p>
              <code>npm run docker:up</code> <code>npm run db:migrate</code>{" "}
              <code>npm run db:seed</code>
            </p>
          </>
        )}
        {error ? <p style={{ color: "var(--text-3)" }}>{error}</p> : null}
      </main>
    );
  }

  const users = await listSwitchableUsers();

  // Group by the compiler's own group_key (the status id), not by status group,
  // or "In Progress" and "In Review" collapse into one section.
  const byStatus = new Map<string, typeof data.rows>();
  for (const row of data.rows) {
    const key = row.group_key ?? "none";
    byStatus.set(key, [...(byStatus.get(key) ?? []), row]);
  }

  const visibleStatuses = data.statuses.filter((s) => s.group !== "closed");

  return (
    <UndoProvider>
      <div className="shell">
        <aside className="sidebar">
          <div className="ws">
            <div className="mark">{data.workspaceName[0]}</div>
            <div className="ws-name">{data.workspaceName}</div>
          </div>

          <nav className="nav-group">
            <a className="nav" href="#"><span className="ic">⌂</span>Home</a>
            <a className="nav" href="#"><span className="ic">✦</span>My Work</a>
            <a className="nav" href="#"><span className="ic">⧉</span>Inbox<span className="count">3</span></a>
          </nav>

          <nav className="nav-group">
            <div className="nav-label">Spaces</div>
            <a className="nav" href="#"><span className="ic">▾</span>{data.spaceName}</a>
            <a className="nav depth-1" href="#" aria-current="page">
              <span className="ic">▤</span>
              {data.listName}
              {/* The list's tasks, not the page's rows — a calendar showing one
                  month must not report the list as empty. */}
              <span className="count">{data.listTaskCount}</span>
            </a>
            <a className="nav depth-1" href="#"><span className="ic">▤</span>Backlog</a>
          </nav>
        </aside>

        <main className="main">
          <header className="header">
            <div className="crumb">
              {data.spaceName}<span>›</span>{data.folderName}<span>›</span>
              <strong>{data.listName}</strong>
            </div>
            <div className="header-right">
              <a className="settings-link" href="/settings/statuses" title="Workspace settings">
                Settings
              </a>
              <UndoButton />
              <UserSwitcher users={users} currentId={viewer.id} />
            </div>
          </header>

          <ViewTabs
            views={data.views}
            currentViewId={data.viewId}
            definition={data.definition}
            savedDefinition={data.savedDefinition}
            dirty={data.dirty}
          />

          <FilterBar
            fields={options.fields}
            values={options}
            filters={data.definition.filters}
          />

          {visibleStatuses.map((status) => {
            const rows = byStatus.get(status.id) ?? [];
            const token = status.group.replace("_", "-");

            return (
              <section key={status.id}>
                <div className="group">
                  {/* Colour comes from the status group, never the name — a
                      custom "Shipping" status is still active blue. */}
                  <span className="group-name" style={{ color: `var(--status-${token})` }}>
                    {status.name}
                  </span>
                  <span className="group-count">{rows.length}</span>
                </div>

                {rows.map((row) => {
                  const task: TaskRowData = {
                    id: row.id,
                    key: row.key,
                    name: row.name,
                    priority: row.priority,
                    statusGroup: row.status_group,
                    dueAt: row.due_at,
                    dueHasTime: row.due_has_time,
                    assignees: data.assignees.get(row.id) ?? [],
                    subtaskCount: data.subtaskCounts.get(row.id) ?? 0,
                  };
                  return <TaskRow key={row.id} task={task} />;
                })}

                <NewTaskRow
                  listId={data.listId}
                  statusId={status.id}
                  statusLabel={status.name}
                />
              </section>
            );
          })}

          <div className="footer-note">
            <span className="live" />
            <span>
              {data.rows.length} {data.rows.length === 1 ? "task" : "tasks"} · acting as {viewer.name} · rendered through the
              @arbor/core view compiler
            </span>
          </div>
        </main>
      </div>
    </UndoProvider>
  );
}
