import { AppShell, FooterNote, type ShellChrome } from "@/components/app-shell";
import { TaskDetail } from "@/components/task-detail";
import { getCurrentUser, listSwitchableUsers } from "@/server/auth";
import { loadTask } from "@/server/task";
import { loadTaskHistory } from "@arbor/db";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * One task, at an address (D-031).
 *
 * `/t/ENG-402` is what someone pastes into a message, so the segment is the
 * human key — falling back to the id, because `tasks.key` is nullable and a
 * keyless task still needs somewhere to live.
 *
 * **A full page rather than an overlay, deliberately and for now.** D-031's
 * shape is the panel opening *over* a list that stays mounted, which in Next is
 * a parallel route plus an interception. Five renderers sit at five different
 * segment roots, so that interception has to exist five times or the renderers
 * have to move into one route group first. The address is the part that is
 * expensive to change later; whether it renders over a list is not.
 *
 * There is **no compiler call here** and that is not a hole in D-032. A view
 * compiles "which rows"; this page already knows the row. What it cannot skip
 * is the thing the compiler was doing for free — the `access_index` join — and
 * that is in `loadTask`, which returns null for a task the viewer cannot reach.
 */
export default async function TaskPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;

  const viewer = await getCurrentUser();
  if (!viewer) redirect("/login");

  let task: Awaited<ReturnType<typeof loadTask>> = null;
  let error: string | null = null;

  try {
    task = await loadTask(key, viewer.id);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) {
    return (
      <main className="empty">
        <h2>Could not reach the database</h2>
        <p>Start the local services and seed the demo workspace:</p>
        <p>
          <code>npm run docker:up</code> <code>npm run db:migrate</code>{" "}
          <code>npm run db:seed</code>
        </p>
        <p style={{ color: "var(--text-3)" }}>{error}</p>
      </main>
    );
  }

  // One page for three different reasons — no such key, deleted, and not
  // yours. Distinguishing them would make this route an existence oracle for
  // every task in every private list (D-080).
  if (!task) {
    return (
      <main className="empty">
        <h2>No such task</h2>
        <p>
          It may have been deleted, or you may not have access to the list it is in.{" "}
          <a href="/">Back to the list</a>.
        </p>
      </main>
    );
  }

  const users = await listSwitchableUsers();

  // Loaded after the task rather than inside `loadTask`: the history is scoped
  // by the same `access_index` join on its own, so it does not depend on the
  // caller having checked, and a task page that fails to render its log is
  // better than one that fails to render at all.
  const history = await loadTaskHistory(task.id, viewer.id);

  const chrome: ShellChrome = {
    workspaceName: task.workspaceName,
    location: {
      spaceName: task.spaceName,
      folderName: task.folderName,
      listName: task.listName,
      listTaskCount: task.listTaskCount,
    },
    viewer,
    users,
  };

  return (
    <AppShell
      chrome={chrome}
      crumb={
        <>
          <a href="/">{task.listName}</a>
          <span>›</span>
          <strong>{task.key ?? task.name}</strong>
        </>
      }
    >
      <TaskDetail task={task} history={history} viewerId={viewer.id} />

      <FooterNote>
        {task.archivedAt ? "archived · " : null}
        created {task.createdByName ? `by ${task.createdByName} ` : ""}
        {task.createdAt ? new Date(task.createdAt).toLocaleDateString("en-GB") : "—"} · acting as{" "}
        {viewer.name} · you hold {task.permission} on {task.listName}
      </FooterNote>
    </AppShell>
  );
}
