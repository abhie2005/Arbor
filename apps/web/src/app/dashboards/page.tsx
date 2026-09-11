import { AppShell, FooterNote, LoadFailure, type ShellChrome } from "@/components/app-shell";
import { Dashboards } from "@/components/dashboards";
import { getCurrentUser, listSwitchableUsers } from "@/server/auth";
import { loadDashboardsPage } from "@/server/dashboards";
import { requireWorkspace } from "@/server/workspace";
import { workspaceRole } from "@arbor/db";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * `/dashboards` — the third screen not scoped to one container, and the one
 * where the compiler does the most work per render.
 *
 * **Every number on it is this viewer's** (D-105). That is the opposite of the
 * goals screen, where a rollup is counted as the goal's owner (D-102), and the
 * difference is not an inconsistency: a goal is a shared commitment with an
 * owner on the row, while a dashboard lives in a container and the rule for
 * what lives in the tree is that you see what you have a grant on (ADR 3). The
 * footer says so, because two people seeing different totals otherwise reads as
 * a bug rather than as the answer.
 */
export default async function DashboardsPage() {
  let viewer: Awaited<ReturnType<typeof getCurrentUser>> = null;
  let page: Awaited<ReturnType<typeof loadDashboardsPage>> | null = null;
  let workspaceName = "";
  let canCreate = false;
  let error: string | null = null;

  try {
    viewer = await getCurrentUser();
    if (viewer) {
      const workspace = await requireWorkspace();
      workspaceName = workspace.name;

      const role = await workspaceRole(workspace.id, viewer.id);
      canCreate = role === "member" || role === "admin" || role === "owner";

      page = await loadDashboardsPage(workspace.id, viewer.id);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // Outside the try on purpose: `redirect` signals by throwing, and the catch
  // above would turn it into an error message on a page nobody should reach.
  if (!viewer) redirect("/login");

  if (error || !page) {
    return <LoadFailure badLink={false} clearTo="/dashboards" error={error} />;
  }

  const users = await listSwitchableUsers();
  const cards = page.dashboards.reduce((total, dashboard) => total + dashboard.resolved.length, 0);

  // No `location`, like the inbox and goals: this screen is not looking at one
  // list, and saying so keeps the breadcrumb honest (D-086).
  const chrome: ShellChrome = { workspaceName, active: "dashboards", viewer, users };

  return (
    <AppShell chrome={chrome} crumb={<strong>Dashboards</strong>}>
      <Dashboards
        dashboards={page.dashboards}
        scopes={page.scopes}
        canCreate={canCreate}
      />

      <FooterNote>
        {cards} {cards === 1 ? "card" : "cards"} · counted as {viewer.name}, so these are the
        numbers you can see
      </FooterNote>
    </AppShell>
  );
}
