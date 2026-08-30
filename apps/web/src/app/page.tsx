import { DEFAULT_VIEW_DEFINITION, compileViewQuery } from "@arbor/core";
import { executeCompiled, pool } from "@arbor/db";

export const dynamic = "force-dynamic";

interface TaskRow {
  id: string;
  key: string | null;
  name: string;
  priority: number | null;
  parent_task_id: string | null;
  due_at: string | null;
  status_group: string | null;
  group_key: string | null;
}

interface Loaded {
  workspace: string;
  space: string;
  folder: string;
  list: string;
  statuses: { id: string; name: string; group: string }[];
  rows: TaskRow[];
  assignees: Map<string, string[]>;
  subtaskCounts: Map<string, number>;
}

/**
 * Reads through the same view compiler the API will use. The page has no
 * bespoke query of its own — if the compiler is wrong, this screen is wrong,
 * which is exactly the coupling we want.
 */
async function load(): Promise<Loaded | null> {
  const connection = pool();

  const meta = await connection.query<{
    workspace_id: string;
    workspace_name: string;
    list_id: string;
    list_name: string;
    folder_name: string;
    space_name: string;
    viewer_id: string;
  }>(`
    SELECT w.id  AS workspace_id, w.name AS workspace_name,
           l.id  AS list_id,      l.name AS list_name,
           f.name AS folder_name, sp.name AS space_name,
           (SELECT id FROM users ORDER BY created_at LIMIT 1) AS viewer_id
    FROM workspaces w
    JOIN containers l  ON l.workspace_id = w.id AND l.kind = 'list'
    LEFT JOIN containers f  ON f.id = l.parent_id
    LEFT JOIN containers sp ON sp.id = COALESCE(f.parent_id, l.parent_id)
    WHERE w.slug = 'northwind' AND l.name = 'Sprint 24'
    LIMIT 1
  `);

  const m = meta.rows[0];
  if (!m) return null;

  // The screen has no query of its own: if the compiler is wrong, this is wrong.
  const rows = await executeCompiled<TaskRow>(
    compileViewQuery({
      workspaceId: m.workspace_id,
      viewerId: m.viewer_id,
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
     WHERE parent_task_id IS NOT NULL AND deleted_at IS NULL
     GROUP BY parent_task_id`,
  );
  const subtaskCounts = new Map(subRows.rows.map((r) => [r.parent_task_id, Number(r.n)]));

  return {
    workspace: m.workspace_name,
    space: m.space_name,
    folder: m.folder_name,
    list: m.list_name,
    statuses: statuses.rows,
    rows,
    assignees,
    subtaskCounts,
  };
}

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function avatarColor(name: string) {
  const hues = ["var(--avatar-1)", "var(--avatar-2)", "var(--avatar-3)", "var(--avatar-4)", "var(--avatar-5)"];
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hues[hash % hues.length];
}

function formatDue(value: string | null) {
  if (!value) return { label: "—", overdue: false, empty: true };
  const date = new Date(value);
  const overdue = date.getTime() < Date.now();
  const label = date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });
  return { label, overdue, empty: false };
}

export default async function Page() {
  let data: Loaded | null = null;
  let error: string | null = null;

  try {
    data = await load();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error || !data) {
    return (
      <main className="empty">
        <h2>{error ? "Could not reach the database" : "No demo workspace yet"}</h2>
        <p>
          {error
            ? "Start the local services, then run the migration."
            : "The schema is migrated but empty. Seed the demo workspace:"}
        </p>
        <p>
          <code>npm run docker:up</code> <code>npm run db:migrate</code>{" "}
          <code>npm run db:seed</code>
        </p>
        {error ? <p style={{ color: "var(--text-3)" }}>{error}</p> : null}
      </main>
    );
  }

  // Group by the compiler's own `group_key` — the status id — rather than by
  // status group, or "In Progress" and "In Review" collapse into one section.
  const byGroup = new Map<string, TaskRow[]>();
  for (const row of data.rows) {
    const key = row.group_key ?? "none";
    byGroup.set(key, [...(byGroup.get(key) ?? []), row]);
  }

  const statusById = new Map(data.statuses.map((s) => [s.id, s]));
  // Status order comes from the status set's own position, not from the query.
  const groupOrder = data.statuses.map((s) => s.id);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="ws">
          <div className="mark">{data.workspace[0]}</div>
          <div className="ws-name">{data.workspace}</div>
        </div>

        <nav className="nav-group">
          <a className="nav" href="#"><span className="ic">⌂</span>Home</a>
          <a className="nav" href="#"><span className="ic">✦</span>My Work</a>
          <a className="nav" href="#"><span className="ic">⧉</span>Inbox<span className="count">3</span></a>
        </nav>

        <nav className="nav-group">
          <div className="nav-label">Spaces</div>
          <a className="nav" href="#"><span className="ic">▾</span>{data.space}</a>
          <a className="nav depth-1" href="#" aria-current="page">
            <span className="ic">▤</span>
            {data.list}
            <span className="count">{data.rows.length}</span>
          </a>
          <a className="nav depth-1" href="#"><span className="ic">▤</span>Backlog</a>
        </nav>
      </aside>

      <main className="main">
        <header className="header">
          <div className="crumb">
            {data.space}<span>›</span>{data.folder}<span>›</span><strong>{data.list}</strong>
          </div>
          <div className="header-right">
            <span className="kbd">⌘K</span>
          </div>
        </header>

        <div className="tabs">
          <a className="tab" href="#" aria-current="page">List</a>
          <a className="tab" href="#">Board</a>
          <a className="tab" href="#">Calendar</a>
          <a className="tab" href="#">Table</a>
        </div>

        {data.rows.length === 0 ? (
          <div className="empty">
            <h2>Nothing here yet</h2>
            <p>Run <code>npm run db:seed</code> to populate the demo workspace.</p>
          </div>
        ) : (
          groupOrder
            .filter((g) => byGroup.has(g))
            .map((group) => {
              const rows = byGroup.get(group) ?? [];
              const status = statusById.get(group);
              // Colour comes from the status *group*, never the status name —
              // a team's custom "Shipping" status is still active blue.
              const groupToken = (status?.group ?? "not_started").replace("_", "-");
              return (
                <section key={group}>
                  <div className="group">
                    <span className="group-name" style={{ color: `var(--status-${groupToken})` }}>
                      {status?.name ?? "Untitled"}
                    </span>
                    <span className="group-count">{rows.length}</span>
                  </div>
                  {rows.map((row) => {
                    const due = formatDue(row.due_at);
                    const people = data.assignees.get(row.id) ?? [];
                    const subs = data.subtaskCounts.get(row.id) ?? 0;
                    return (
                      <div className="row" key={row.id}>
                        <span className="dot" data-group={row.status_group ?? undefined} />
                        <span className="key">{row.key ?? "—"}</span>
                        <span className="title">
                          {row.name}
                          {subs > 0 ? <span className="sub">{subs} subtasks</span> : null}
                        </span>
                        <span className="flag" data-priority={row.priority ?? undefined}>
                          {row.priority ? "▲" : ""}
                        </span>
                        <span className="date" data-overdue={due.overdue} data-empty={due.empty}>
                          {due.label}
                        </span>
                        <span className="avatars">
                          {people.map((name) => (
                            <span
                              key={name}
                              className="avatar"
                              style={{ background: avatarColor(name) }}
                              title={name}
                            >
                              {initials(name)}
                            </span>
                          ))}
                        </span>
                      </div>
                    );
                  })}
                </section>
              );
            })
        )}

        <div className="footer-note">
          <span className="live" />
          <span>
            {data.rows.length} tasks · rendered through @arbor/core view compiler
          </span>
        </div>
      </main>
    </div>
  );
}
