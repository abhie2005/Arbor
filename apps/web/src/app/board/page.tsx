import { Board, type BoardColumn } from "@/components/board";
import { UndoButton, UndoProvider } from "@/components/undo";
import { UserSwitcher } from "@/components/user-switcher";
import { ViewTabs } from "@/components/view-tabs";
import { getCurrentUser, listSwitchableUsers } from "@/server/auth";
import { loadView } from "@/server/views";

export const dynamic = "force-dynamic";

/**
 * The board renderer.
 *
 * There is no board query. A board is the same compiled view as the list with
 * `grouping.field = "status"` — which the saved definition already says — so
 * this file's entire job is turning rows the compiler already grouped into
 * columns.
 *
 * The one override is `showSubtasks: 1`: a board shows subtasks as their own
 * cards rather than nesting them, because a column is a flat sequence and
 * there is nowhere for a nested row to go.
 */
export default async function BoardPage() {
  let viewer: Awaited<ReturnType<typeof getCurrentUser>> = null;
  let data: Awaited<ReturnType<typeof loadView>> = null;
  let error: string | null = null;

  try {
    viewer = await getCurrentUser();
    if (viewer) {
      data = await loadView(viewer.id, "board", {
        grouping: { field: "status", dir: "asc" },
        filters: { op: "AND", conditions: [], showClosed: false, showSubtasks: 1 },
      });
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error || !viewer || !data) {
    return (
      <main className="empty">
        <h2>{error ? "Could not reach the database" : "No demo workspace yet"}</h2>
        <p>
          <code>npm run docker:up</code> <code>npm run db:migrate</code>{" "}
          <code>npm run db:seed</code>
        </p>
        {error ? <p style={{ color: "var(--text-3)" }}>{error}</p> : null}
      </main>
    );
  }

  const users = await listSwitchableUsers();

  const byStatus = new Map<string, typeof data.rows>();
  for (const row of data.rows) {
    const key = row.group_key ?? "none";
    byStatus.set(key, [...(byStatus.get(key) ?? []), row]);
  }

  const columns: BoardColumn[] = data.statuses
    .filter((status) => status.group !== "closed")
    .map((status) => ({
      statusId: status.id,
      name: status.name,
      group: status.group,
      color: status.color,
      // From compileGroupCounts, not from the cards on screen: a column that is
      // paginated or collapsed still has to show its real size.
      count: data.counts.get(status.id) ?? 0,
      cards: (byStatus.get(status.id) ?? []).map((row) => ({
        id: row.id,
        key: row.key,
        name: row.name,
        priority: row.priority,
        dueAt: row.due_at,
        statusGroup: row.status_group,
        assignees: data.assignees.get(row.id) ?? [],
        subtaskCount: data.subtaskCounts.get(row.id) ?? 0,
      })),
    }));

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
              <span className="count">{data.rows.length}</span>
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

          <ViewTabs />

          <Board columns={columns} />

          <div className="footer-note">
            <span className="live" />
            <span>
              {data.rows.length} tasks · acting as {viewer.name} · same compiler as the list,
              grouped by status
            </span>
          </div>
        </main>
      </div>
    </UndoProvider>
  );
}
