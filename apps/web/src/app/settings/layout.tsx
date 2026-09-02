import Link from "next/link";

import { SettingsTabs } from "@/components/settings/tabs";
import { requireWorkspace } from "@/server/workspace";

export const dynamic = "force-dynamic";

/**
 * Settings is a route, not a modal — the same reasoning as the task detail
 * panel (D-031). Configuration is where people send each other links: "the
 * status set is here". A modal has no address.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const workspace = await requireWorkspace();

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

      <main className="main">{children}</main>
    </div>
  );
}
