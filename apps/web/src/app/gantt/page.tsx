import {
  daysOfMonth,
  dayKeyFor,
  isMonth,
  isOverdue,
  monthBounds,
  monthOf,
  utcDayKey,
} from "@arbor/core";
import { redirect } from "next/navigation";

import { FilterBar } from "@/components/filter-bar";
import { Gantt, type GanttBar } from "@/components/gantt";
import { UndoButton, UndoProvider } from "@/components/undo";
import { UserSwitcher } from "@/components/user-switcher";
import { ViewTabs } from "@/components/view-tabs";
import { getCurrentUser, listSwitchableUsers } from "@/server/auth";
import { loadFilterOptions, loadView } from "@/server/views";
import { requireWorkspace } from "@/server/workspace";

export const dynamic = "force-dynamic";

/**
 * The timeline renderer.
 *
 * The one STATUS expected might break the compiler bet, and the answer is
 * interesting: the rows are the same compiled query, but the *scope* was not
 * expressible. A bar belongs on screen when it overlaps the window, which for
 * tasks that have only one of the two dates is
 * `(start IS NULL OR start <= end) AND (due IS NULL OR due >= begin)` — mixed
 * AND and OR, and a filter group was a flat list joined by one operator.
 *
 * So the compiler learned to nest clauses, and this page appends one. That is
 * the bet holding in the way that matters: the renderer did not grow a query,
 * the query layer grew an expression.
 */
export default async function GanttPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string; m?: string; view?: string }>;
}) {
  let viewer: Awaited<ReturnType<typeof getCurrentUser>> = null;
  let data: Awaited<ReturnType<typeof loadView>> = null;
  let options: Awaited<ReturnType<typeof loadFilterOptions>> | null = null;
  let error: string | null = null;

  const { f, m, view } = await searchParams;

  const today = utcDayKey(new Date());
  const month = isMonth(m) ? m : monthOf(today);
  const days = daysOfMonth(month);
  const window = monthBounds(month);

  try {
    viewer = await getCurrentUser();
    if (viewer) {
      const workspace = await requireWorkspace();
      [data, options] = await Promise.all([
        loadView({
          viewerId: viewer.id,
          type: "gantt",
          viewId: view,
          filterParam: f,
          override: {
            grouping: { field: "none", dir: "asc" },
            filters: { showSubtasks: 1 } as never,
            // Earliest first, so a timeline reads top-left to bottom-right.
            sort: [
              { field: "startAt", dir: "asc" },
              { field: "dueAt", dir: "asc" },
            ],
          },
          // Overlap, expressed with the nesting the compiler learned for this.
          // A task with neither date is excluded by both clauses at once, which
          // is right: it is not on a timeline.
          required: [
            {
              op: "OR",
              conditions: [
                { field: "startAt", op: "isNull" },
                { field: "startAt", op: "lt", value: window.to },
              ],
            },
            {
              op: "OR",
              conditions: [
                { field: "dueAt", op: "isNull" },
                { field: "dueAt", op: "gte", value: window.from },
              ],
            },
            {
              op: "OR",
              conditions: [
                { field: "startAt", op: "isNotNull" },
                { field: "dueAt", op: "isNotNull" },
              ],
            },
          ],
          limit: 500,
        }),
        loadFilterOptions(workspace.id),
      ]);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (!viewer) redirect("/login");

  if (error || !data || !options) {
    const badLink = error !== null && f !== undefined;

    return (
      <main className="empty">
        <h2>{badLink ? "That link is not valid" : error ? "Could not reach the database" : "No demo workspace yet"}</h2>
        {badLink ? (
          <p>
            <a href="/gantt">Clear it</a> and start again.
          </p>
        ) : (
          <p>
            <code>npm run docker:up</code> <code>npm run db:migrate</code>{" "}
            <code>npm run db:seed</code>
          </p>
        )}
        {error ? <p style={{ color: "var(--text-3)" }}>{error}</p> : null}
      </main>
    );
  }

  const users = await listSwitchableUsers();

  const bars: GanttBar[] = data.rows.map((row) => {
    const start = row.start_at as string | null;
    const due = row.due_at;

    return {
      id: row.id,
      key: row.key,
      name: row.name,
      startDay: start ? dayKeyFor(start, row.start_has_time === true) : null,
      dueDay: due ? dayKeyFor(due, row.due_has_time === true) : null,
      statusGroup: row.status_group,
      overdue: isOverdue(due, row.due_has_time === true),
    };
  });

  return (
    <UndoProvider>
      <div className="shell">
        <aside className="sidebar">
          <div className="ws">
            <div className="mark">{data.workspaceName[0]}</div>
            <div className="ws-name">{data.workspaceName}</div>
          </div>

          <nav className="nav-group">
            <a className="nav" href="#"><span className="ic">&#8962;</span>Home</a>
            <a className="nav" href="#"><span className="ic">&#10022;</span>My Work</a>
            <a className="nav" href="#"><span className="ic">&#9033;</span>Inbox<span className="count">3</span></a>
          </nav>

          <nav className="nav-group">
            <div className="nav-label">Spaces</div>
            <a className="nav" href="#"><span className="ic">&#9662;</span>{data.spaceName}</a>
            <a className="nav depth-1" href="#" aria-current="page">
              <span className="ic">&#9636;</span>
              {data.listName}
              <span className="count">{data.listTaskCount}</span>
            </a>
            <a className="nav depth-1" href="#"><span className="ic">&#9636;</span>Backlog</a>
          </nav>
        </aside>

        <main className="main">
          <header className="header">
            <div className="crumb">
              {data.spaceName}<span>&#8250;</span>{data.folderName}<span>&#8250;</span>
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

          <FilterBar fields={options.fields} values={options} filters={data.definition.filters} />

          <Gantt month={month} days={days} bars={bars} today={today} />

          <div className="footer-note">
            <span className="live" />
            <span>
              {bars.length} {bars.length === 1 ? "task" : "tasks"} overlapping this month · acting as{" "}
              {viewer.name} · same compiler as the list, scoped with a nested clause
            </span>
          </div>
        </main>
      </div>
    </UndoProvider>
  );
}
