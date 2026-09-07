import type { ReactNode } from "react";

import { UndoButton, UndoProvider } from "@/components/undo";
import { UserSwitcher } from "@/components/user-switcher";

/**
 * The chrome every screen sits inside.
 *
 * Extracted at the sixth copy, which is five too late. Four renderer pages
 * each carried their own sidebar, header, error state and footer — around
 * sixty lines apiece — and every one of them was a place for the four to drift
 * apart. They already had: the list said "That filter link is not valid" where
 * the other three said "That link is not valid", and only the list explained
 * what to do about a missing database.
 *
 * The parts are separate components rather than one `<AppShell>` with a dozen
 * props, because the pieces are not always used together: a task detail page
 * wants the sidebar and header but no view tabs and no filter bar, and a
 * failure state wants none of it.
 */

export interface ShellChrome {
  workspaceName: string;
  spaceName: string;
  /**
   * Empty when the list sits straight under its space. The breadcrumb drops
   * the segment rather than repeating the space, which is what falling back to
   * the space name produced: "Founders › Founders › Hiring".
   */
  folderName: string;
  listName: string;
  /**
   * The list's tasks, not the page's rows — a calendar showing one month must
   * not report the list as empty (D-069).
   */
  listTaskCount: number;
  viewer: { id: string; name: string };
  /** Empty outside development, which is what hides the switcher (D-034). */
  users: { id: string; name: string }[];
}

/**
 * `crumb` overrides the breadcrumb's last segment. A renderer is looking at a
 * list, so the list is the leaf; a task detail page is one level deeper and
 * says so.
 */
export function AppShell({
  chrome,
  crumb,
  children,
}: {
  chrome: ShellChrome;
  crumb?: ReactNode;
  children: ReactNode;
}) {
  return (
    <UndoProvider>
      <div className="shell">
        <Sidebar chrome={chrome} />

        <main className="main">
          <header className="header">
            <div className="crumb">
              {chrome.spaceName}
              <span>›</span>
              {chrome.folderName ? (
                <>
                  {chrome.folderName}
                  <span>›</span>
                </>
              ) : null}
              {crumb ?? <strong>{chrome.listName}</strong>}
            </div>
            <div className="header-right">
              <a className="settings-link" href="/settings/statuses" title="Workspace settings">
                Settings
              </a>
              <UndoButton />
              <UserSwitcher users={chrome.users} currentId={chrome.viewer.id} />
            </div>
          </header>

          {children}
        </main>
      </div>
    </UndoProvider>
  );
}

function Sidebar({ chrome }: { chrome: ShellChrome }) {
  return (
    <aside className="sidebar">
      <div className="ws">
        <div className="mark">{chrome.workspaceName[0]}</div>
        <div className="ws-name">{chrome.workspaceName}</div>
      </div>

      <nav className="nav-group">
        <a className="nav" href="#">
          <span className="ic">⌂</span>Home
        </a>
        <a className="nav" href="#">
          <span className="ic">✦</span>My Work
        </a>
        {/* The count is a placeholder until notifications land — see STATUS. */}
        <a className="nav" href="#">
          <span className="ic">⧉</span>Inbox<span className="count">3</span>
        </a>
      </nav>

      <nav className="nav-group">
        <div className="nav-label">Spaces</div>
        <a className="nav" href="#">
          <span className="ic">▾</span>
          {chrome.spaceName}
        </a>
        <a className="nav depth-1" href="#" aria-current="page">
          <span className="ic">▤</span>
          {chrome.listName}
          <span className="count">{chrome.listTaskCount}</span>
        </a>
        <a className="nav depth-1" href="#">
          <span className="ic">▤</span>Backlog
        </a>
      </nav>
    </aside>
  );
}

/** The status line under a renderer. The sentence is the page's own. */
export function FooterNote({ children }: { children: ReactNode }) {
  return (
    <div className="footer-note">
      <span className="live" />
      <span>{children}</span>
    </div>
  );
}

/**
 * The page that renders instead when loading failed.
 *
 * A bad link is a different failure from a missing database, and saying so is
 * the difference between "fix your link" and "start Docker" (D-042). `clearTo`
 * is where "Clear it" goes — the same screen without the parameter.
 */
export function LoadFailure({
  badLink,
  clearTo,
  error,
}: {
  badLink: boolean;
  clearTo: string;
  error: string | null;
}) {
  return (
    <main className="empty">
      <h2>
        {badLink
          ? "That link is not valid"
          : error
            ? "Could not reach the database"
            : "No demo workspace yet"}
      </h2>
      {badLink ? (
        <p>
          <a href={clearTo}>Clear it</a> and start again.
        </p>
      ) : (
        <>
          <p>Start the local services and seed the demo workspace:</p>
          <p>
            <code>npm run docker:up</code> <code>npm run db:migrate</code>{" "}
            <code>npm run db:seed</code>
          </p>
        </>
      )}
      {error ? <p style={{ color: "var(--text-3)" }}>{error}</p> : null}
    </main>
  );
}

/**
 * The chrome a renderer needs, from what `loadView` already returned.
 *
 * A one-line call per page rather than a nine-line object literal repeated
 * five times — the duplication this file exists to remove would otherwise come
 * straight back as a props bag.
 */
export function chromeFrom(
  data: {
    workspaceName: string;
    spaceName: string;
    folderName: string;
    listName: string;
    listTaskCount: number;
  },
  viewer: { id: string; name: string },
  users: { id: string; name: string }[],
): ShellChrome {
  return {
    workspaceName: data.workspaceName,
    spaceName: data.spaceName,
    folderName: data.folderName,
    listName: data.listName,
    listTaskCount: data.listTaskCount,
    viewer,
    users,
  };
}
