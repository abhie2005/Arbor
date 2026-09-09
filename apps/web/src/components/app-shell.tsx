import type { ReactNode } from "react";

import { Live } from "@/components/live";
import { UndoButton, UndoProvider } from "@/components/undo";
import { UserSwitcher } from "@/components/user-switcher";
import { inboxBadge } from "@/server/inbox";

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

/**
 * Where the screen is in the tree, when it is anywhere in it.
 *
 * One object rather than five sibling fields because they are only ever true
 * together (D-086). A screen looking at a list knows all of them; the inbox
 * knows none, and "a folder name with no list" is not a state anything should
 * be able to express.
 */
export interface ShellLocation {
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
}

export interface ShellChrome {
  workspaceName: string;
  /**
   * Absent on a screen that is not looking at one list. The inbox is the first
   * — "what is mine, anywhere" has no container to name.
   */
  location?: ShellLocation;
  /** Which top-level entry is the current screen, when the screen is one of them. */
  active?: "inbox";
  /**
   * The one thing this screen is looking at, when it is one thing — a task id.
   *
   * It is what the live stream registers as presence, so it is deliberately not
   * "the list": people gather on a task, and "seventeen people are on Sprint 24"
   * is a fact nobody acts on (D-092).
   */
  scope?: string;
  viewer: { id: string; name: string };
  /** Empty outside development, which is what hides the switcher (D-034). */
  users: { id: string; name: string }[];
}

/**
 * `crumb` overrides the breadcrumb's last segment. A renderer is looking at a
 * list, so the list is the leaf; a task detail page is one level deeper and
 * says so. A screen with no location has nothing else in the trail, so its
 * crumb is the whole of it.
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
  const { location } = chrome;

  return (
    <UndoProvider>
      {/* Mounted in the shell so every screen is live, rather than each page
          remembering to be — the same reason the badge is fetched here. It
          wraps rather than sits beside, because presence reaches a component
          inside the page (D-092). */}
      <Live viewerId={chrome.viewer.id} scope={chrome.scope}>
      <div className="shell">
        <Sidebar chrome={chrome} />

        <main className="main">
          <header className="header">
            <div className="crumb">
              {location ? (
                <>
                  {location.spaceName}
                  <span>›</span>
                  {location.folderName ? (
                    <>
                      {location.folderName}
                      <span>›</span>
                    </>
                  ) : null}
                  {crumb ?? <strong>{location.listName}</strong>}
                </>
              ) : (
                crumb
              )}
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
      </Live>
    </UndoProvider>
  );
}

/**
 * The sidebar counts the inbox itself rather than being handed the number
 * (D-085).
 *
 * The badge belongs to the chrome, not to any one screen, and there are seven
 * screens: threading it through `chromeFrom` would mean seven call sites that
 * all have to remember to fetch it, which is the same drift this file was
 * extracted to end. `inboxBadge` is request-cached, so the inbox page asking
 * for the same number costs one query, not two.
 */
async function Sidebar({ chrome }: { chrome: ShellChrome }) {
  const unread = await inboxBadge(chrome.viewer.id);
  const { location } = chrome;

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
        <a
          className="nav"
          href="/inbox"
          aria-current={chrome.active === "inbox" ? "page" : undefined}
        >
          <span className="ic">⧉</span>Inbox
          {/* No badge at zero: an empty inbox should look empty, and a `0`
              sitting where a count goes reads as a number worth checking. */}
          {unread ? <span className="count" data-unread>{unread}</span> : null}
        </a>
      </nav>

      {location ? (
        <nav className="nav-group">
          <div className="nav-label">Spaces</div>
          <a className="nav" href="#">
            <span className="ic">▾</span>
            {location.spaceName}
          </a>
          <a
            className="nav depth-1"
            href="#"
            aria-current={chrome.active ? undefined : "page"}
          >
            <span className="ic">▤</span>
            {location.listName}
            <span className="count">{location.listTaskCount}</span>
          </a>
          <a className="nav depth-1" href="#">
            <span className="ic">▤</span>Backlog
          </a>
        </nav>
      ) : (
        // A screen with no location has no Spaces group to sit in, and would
        // otherwise be a dead end: every other entry up there is a placeholder.
        // Settings solves it the same way.
        <nav className="nav-group">
          <a className="nav" href="/">
            <span className="ic">←</span>Back to work
          </a>
        </nav>
      )}
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
    location: {
      spaceName: data.spaceName,
      folderName: data.folderName,
      listName: data.listName,
      listTaskCount: data.listTaskCount,
    },
    viewer,
    users,
  };
}
