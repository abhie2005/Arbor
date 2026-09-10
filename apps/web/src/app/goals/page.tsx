import { AppShell, FooterNote, LoadFailure, type ShellChrome } from "@/components/app-shell";
import { Goals } from "@/components/goals";
import { getCurrentUser, listSwitchableUsers } from "@/server/auth";
import { loadGoalsPage } from "@/server/goals";
import { requireWorkspace } from "@/server/workspace";
import { workspaceRole } from "@arbor/db";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * `/goals` — the second screen that is not scoped to a container.
 *
 * The inbox was the first, and for a different reason: it asks "what is mine,
 * anywhere". This one has nothing to scope *to* — `goals` has a workspace and
 * an owner and no container, which is the schema saying a goal is a
 * workspace-level object, and the honest consequence is that every member sees
 * every goal. That is a real gap and it is recorded in `docs/STATUS.md` rather
 * than papered over with a filter that would only look like privacy.
 *
 * **No compiler call here either, and this one is interesting.** The numbers on
 * this page come from the compiler — every rollup is a compiled aggregate — but
 * they are compiled as the *goal's owner* rather than as the viewer (D-102), so
 * the usual "the page reads through the compiler as you" is exactly what does
 * not happen. `listGoals` owns that, and the reason it is not on this page is
 * that a screen deciding whose permissions to read with would be a screen that
 * could get it wrong.
 */
export default async function GoalsPage() {
  let viewer: Awaited<ReturnType<typeof getCurrentUser>> = null;
  let page: Awaited<ReturnType<typeof loadGoalsPage>> | null = null;
  let workspaceName = "";
  let isAdmin = false;
  let canCreate = false;
  let error: string | null = null;

  try {
    viewer = await getCurrentUser();
    if (viewer) {
      const workspace = await requireWorkspace();
      workspaceName = workspace.name;

      const role = await workspaceRole(workspace.id, viewer.id);
      isAdmin = role === "admin" || role === "owner";
      // A guest can read the workspace; setting its targets is a member's job.
      canCreate = isAdmin || role === "member";

      page = await loadGoalsPage(workspace.id);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // Outside the try on purpose: `redirect` signals by throwing, and the catch
  // above would turn it into an error message on a page nobody should reach.
  if (!viewer) redirect("/login");

  if (error || !page) {
    return <LoadFailure badLink={false} clearTo="/goals" error={error} />;
  }

  const users = await listSwitchableUsers();

  // No `location`, like the inbox: this screen is not looking at a list, and
  // saying so is what keeps the breadcrumb and the sidebar honest (D-086).
  const chrome: ShellChrome = { workspaceName, active: "goals", viewer, users };

  return (
    <AppShell chrome={chrome} crumb={<strong>Goals</strong>}>
      <Goals
        goals={page.goals}
        people={page.people}
        scopes={page.scopes}
        viewerId={viewer.id}
        canCreate={canCreate}
        isAdmin={isAdmin}
      />

      <FooterNote>
        {page.goals.length} {page.goals.length === 1 ? "goal" : "goals"} · rollups counted as
        each goal&rsquo;s owner · acting as {viewer.name}
      </FooterNote>
    </AppShell>
  );
}
