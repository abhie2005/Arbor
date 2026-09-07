import {
  dayKeyFor,
  isMonth,
  isOverdue,
  monthGrid,
  monthOf,
  monthRange,
  utcDayKey,
} from "@arbor/core";

import { Calendar, type CalendarTask } from "@/components/calendar";
import { FilterBar } from "@/components/filter-bar";
import { UndoButton, UndoProvider } from "@/components/undo";
import { UserSwitcher } from "@/components/user-switcher";
import { ViewTabs } from "@/components/view-tabs";
import { getCurrentUser, listSwitchableUsers } from "@/server/auth";
import { loadFilterOptions, loadView } from "@/server/views";
import { requireWorkspace } from "@/server/workspace";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Which date a calendar's squares mean. Anything else falls back to the due date. */
function dateFieldOf(settings: Record<string, unknown> | undefined): "dueAt" | "startAt" {
  return settings?.dateField === "startAt" ? "startAt" : "dueAt";
}

/**
 * The calendar renderer.
 *
 * The first view whose shape is not a list of rows, and the measurement STATUS
 * was waiting for: it needed no compiler change and no new SQL. A month is the
 * same compiled query with one condition appended — the date falls inside the
 * six weeks on screen — expressed with the `between` operator the compiler
 * already had.
 *
 * Three overrides. `grouping: none`, because the grid *is* the grouping and a
 * group key nothing draws only reorders rows. `showSubtasks: 1`, because a
 * square is a flat list with nowhere to nest. And a page size raised to the
 * compiler's maximum, since a month is a bounded window rather than a page
 * someone scrolls — a task missing from a square because it fell past a limit
 * would be indistinguishable from one that is not scheduled.
 */
export default async function CalendarPage({
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
  // An unparseable month is the current one rather than an error: unlike a
  // filter, there is no ambiguity about what was meant and nothing is hidden
  // by showing this month instead.
  const month = isMonth(m) ? m : monthOf(today);
  const weeks = monthGrid(month);
  const range = monthRange(month);

  try {
    viewer = await getCurrentUser();
    if (viewer) {
      const workspace = await requireWorkspace();
      const saved = await loadView({ viewerId: viewer.id, type: "calendar", viewId: view });
      const field = dateFieldOf(saved?.definition.settings);

      [data, options] = await Promise.all([
        loadView({
          viewerId: viewer.id,
          type: "calendar",
          viewId: view,
          filterParam: f,
          override: {
            grouping: { field: "none", dir: "asc" },
            filters: { showSubtasks: 1 } as never,
          },
          // Appended after the URL has had its say, so a link cannot widen the
          // month it claims to be showing.
          required: [{ field, op: "between", value: [range.from, range.to] }],
          limit: 500,
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
    const badLink = error !== null && f !== undefined;

    return (
      <main className="empty">
        <h2>{badLink ? "That link is not valid" : error ? "Could not reach the database" : "No demo workspace yet"}</h2>
        {badLink ? (
          <p>
            <a href="/calendar">Clear it</a> and start again.
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
  const field = dateFieldOf(data.definition.settings);
  const column = field === "dueAt" ? "due_at" : "start_at";
  const flag = field === "dueAt" ? "due_has_time" : "start_has_time";

  // Placed on the server, so the square a task sits in is decided once and does
  // not move between the server's render and the browser's (D-067).
  const tasks: CalendarTask[] = data.rows.flatMap((row) => {
    const value = row[column] as string | null;
    if (!value) return [];

    return [
      {
        id: row.id,
        key: row.key,
        name: row.name,
        day: dayKeyFor(value, row[flag] === true),
        statusGroup: row.status_group,
        priority: row.priority,
        overdue: field === "dueAt" && isOverdue(value, row[flag] === true),
      },
    ];
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

          <Calendar month={month} weeks={weeks} tasks={tasks} dateField={field} today={today} />

          <div className="footer-note">
            <span className="live" />
            <span>
              {tasks.length} {tasks.length === 1 ? "task" : "tasks"} with a{" "}
              {field === "dueAt" ? "due" : "start"} date this month · acting as {viewer.name} ·
              same compiler as the list, filtered to the weeks on screen
            </span>
          </div>
        </main>
      </div>
    </UndoProvider>
  );
}
