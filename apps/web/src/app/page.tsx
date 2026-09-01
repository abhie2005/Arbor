import { DEFAULT_VIEW_DEFINITION, compileViewQuery } from "@arbor/core";
import { executeCompiled, pool } from "@arbor/db";

import { NewTaskRow } from "@/components/new-task";
import { TaskRow, type TaskRowData } from "@/components/task-row";
import { UndoButton, UndoProvider } from "@/components/undo";
import { UserSwitcher } from "@/components/user-switcher";
import { getCurrentUser, listSwitchableUsers } from "@/server/auth";

export const dynamic = "force-dynamic";

/**
 * Snake_case because these come straight off the compiler's SELECT list.
 * The index signature satisfies `executeCompiled`'s row constraint — the
 * compiler can select columns this type doesn't enumerate.
 */
interface CompiledTaskRow {
  [column: string]: unknown;
  id: string;
  key: string | null;
  name: string;
  priority: number | null;
  parent_task_id: string | null;
  due_at: string | null;
  status_group: string | null;
  group_key: string | null;
}

async function load(viewerId: string) {
  const connection = pool();

  const meta = await connection.query<{
    workspace_id: string;
    workspace_name: string;
    list_id: string;
    list_name: string;
    folder_name: string;
    space_name: string;
  }>(`
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

  const m = meta.rows[0];
  if (!m) return null;

  // The screen has no query of its own (D-032): it reads through the same
  // compiler the API uses, so a broken compiler is a visibly broken screen.
  const rows = await executeCompiled<CompiledTaskRow>(
    compileViewQuery({
      workspaceId: m.workspace_id,
      viewerId,
      scope: { kind: "list", id: m.list_id },
      definition: {
        ...DEFAULT_VIEW_DEFINITION,
        filters: { op: "AND", conditions: [], showClosed: false, showSubtasks: 3 },
      },
    }),
    connection,
  );

  const statuses = await connection.query<{ id: string; name: string; group: string }>(
    `SELECT st.id, st.name, st."group" FROM statuses st
     JOIN status_sets ss ON ss.id = st.status_set_id
     WHERE ss.workspace_id = $1 ORDER BY st.position`,
    [m.workspace_id],
  );

  const assigneeRows = await connection.query<{ task_id: string; name: string }>(
    `SELECT ta.task_id, u.name FROM task_assignees ta JOIN users u ON u.id = ta.user_id`,
  );
  const assignees = new Map<string, string[]>();
  for (const r of assigneeRows.rows) {
    assignees.set(r.task_id, [...(assignees.get(r.task_id) ?? []), r.name]);
  }

  const subRows = await connection.query<{ parent_task_id: string; n: string }>(
    `SELECT parent_task_id, COUNT(*) AS n FROM tasks
     WHERE parent_task_id IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL
     GROUP BY parent_task_id`,
  );
  const subtaskCounts = new Map(subRows.rows.map((r) => [r.parent_task_id, Number(r.n)]));

  return { ...m, rows, statuses: statuses.rows, assignees, subtaskCounts };
}

export default async function Page() {
  let viewer: Awaited<ReturnType<typeof getCurrentUser>> = null;
  let data: Awaited<ReturnType<typeof load>> = null;
  let error: string | null = null;

  try {
    viewer = await getCurrentUser();
    if (viewer) data = await load(viewer.id);
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
  const byStatus = new Map<string, CompiledTaskRow[]>();
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
            <div className="mark">{data.workspace_name[0]}</div>
            <div className="ws-name">{data.workspace_name}</div>
          </div>

          <nav className="nav-group">
            <a className="nav" href="#"><span className="ic">⌂</span>Home</a>
            <a className="nav" href="#"><span className="ic">✦</span>My Work</a>
            <a className="nav" href="#"><span className="ic">⧉</span>Inbox<span className="count">3</span></a>
          </nav>

          <nav className="nav-group">
            <div className="nav-label">Spaces</div>
            <a className="nav" href="#"><span className="ic">▾</span>{data.space_name}</a>
            <a className="nav depth-1" href="#" aria-current="page">
              <span className="ic">▤</span>
              {data.list_name}
              <span className="count">{data.rows.length}</span>
            </a>
            <a className="nav depth-1" href="#"><span className="ic">▤</span>Backlog</a>
          </nav>
        </aside>

        <main className="main">
          <header className="header">
            <div className="crumb">
              {data.space_name}<span>›</span>{data.folder_name}<span>›</span>
              <strong>{data.list_name}</strong>
            </div>
            <div className="header-right">
              <UndoButton />
              <UserSwitcher users={users} currentId={viewer.id} />
            </div>
          </header>

          <div className="tabs">
            <a className="tab" href="#" aria-current="page">List</a>
            <a className="tab" href="#">Board</a>
            <a className="tab" href="#">Calendar</a>
            <a className="tab" href="#">Table</a>
          </div>

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
                  listId={data.list_id}
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
