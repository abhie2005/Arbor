import { NewTaskRow } from "@/components/new-task";
import { TaskRow, type TaskRowData } from "@/components/task-row";
import { UndoButton, UndoProvider } from "@/components/undo";
import { UserSwitcher } from "@/components/user-switcher";
import { ViewTabs } from "@/components/view-tabs";
import { getCurrentUser, listSwitchableUsers } from "@/server/auth";
import { loadView } from "@/server/views";

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
export default async function Page() {
  let viewer: Awaited<ReturnType<typeof getCurrentUser>> = null;
  let data: Awaited<ReturnType<typeof loadView>> = null;
  let error: string | null = null;

  try {
    viewer = await getCurrentUser();
    if (viewer) {
      data = await loadView(viewer.id, "list", {
        filters: { op: "AND", conditions: [], showClosed: false, showSubtasks: 3 },
      });
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error || !viewer || !data) {
    return (
      <main className="empty">
        <h2>{error ? "Could not reach the database" : "No demo workspace yet"}</h2>
        <p>Start the local services and seed the demo workspace:</p>
        <p>
          <code>npm run docker:up</code> <code>npm run db:migrate</code>{" "}
          <code>npm run db:seed</code>
        </p>
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
              {data.rows.length} tasks · acting as {viewer.name} · rendered through the
              @arbor/core view compiler
            </span>
          </div>
        </main>
      </div>
    </UndoProvider>
  );
}
