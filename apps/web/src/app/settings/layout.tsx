import Link from "next/link";
import { redirect } from "next/navigation";

import { SettingsTabs } from "@/components/settings/tabs";
import { workspaceRole } from "@arbor/db";

import { getCurrentUser } from "@/server/auth";
import { requireWorkspace } from "@/server/workspace";

export const dynamic = "force-dynamic";

/**
 * Settings is a route, not a modal — the same reasoning as the task detail
 * panel (D-031). Configuration is where people send each other links: "the
 * status set is here". A modal has no address.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  // Settings writes configuration, so it needs an actor for the activity log
  // as much as the work screens do.
  const viewer = await getCurrentUser();
  if (!viewer) redirect("/login");

  const workspace = await requireWorkspace();

  // Configuration is administered rather than edited (D-081), so a member's
  // controls here will be refused by the server. Saying so once at the top
  // beats fifteen controls that look live and are not — the same rule the
  // unsortable table headers follow (D-065).
  const role = await workspaceRole(workspace.id, viewer.id);
  const readOnly = role !== "owner" && role !== "admin";

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="ws">
          <div className="mark">{workspace.name[0]}</div>
          <div className="ws-name">{workspace.name}</div>
        </div>

        <nav className="nav-group">
          <Link className="nav" href="/">
            <span className="ic">←</span>Back to work
          </Link>
        </nav>

        <nav className="nav-group">
          <div className="nav-label">Settings</div>
          <SettingsTabs />
        </nav>
      </aside>

      <main className="main">
        {readOnly ? (
          <div className="notice">
            You are a {role ?? "guest"} in this workspace. Statuses, fields, task types and
            sharing are workspace configuration, so only an owner or admin can change them.
            Everything here is readable; saving will be refused.
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
