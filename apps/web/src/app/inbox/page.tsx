import { AppShell, FooterNote, LoadFailure, type ShellChrome } from "@/components/app-shell";
import { Inbox } from "@/components/inbox";
import { getCurrentUser, listSwitchableUsers } from "@/server/auth";
import { inboxBadge, loadInboxRows } from "@/server/inbox";
import { requireWorkspace } from "@/server/workspace";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * `/inbox` — the first screen in the app that is not scoped to a container.
 *
 * Every other page names a list and reads through the compiler, which joins
 * `access_index` for that one list (D-032). This one asks "what is mine,
 * anywhere", so there is no list to name and no view to compile — and the
 * permission rule is unchanged rather than waived: `loadInbox` joins the same
 * index on *each row's own* list. A notification is a record that something
 * happened, not a licence to see it, so access lost after the write takes the
 * row out of the inbox.
 *
 * `?all=1` is in the URL for the same reason filters are: it is a state worth
 * linking to, and the two lists are different enough to be worth naming.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const { all } = await searchParams;
  const includeRead = all === "1";

  let viewer: Awaited<ReturnType<typeof getCurrentUser>> = null;
  let rows: Awaited<ReturnType<typeof loadInboxRows>> | null = null;
  let unread = 0;
  let workspaceName = "";
  let error: string | null = null;

  try {
    viewer = await getCurrentUser();
    if (viewer) {
      const workspace = await requireWorkspace();
      workspaceName = workspace.name;

      // The count is the whole inbox and the rows are one page of it, so both
      // are asked for. `inboxBadge` is request-cached, so the sidebar's copy of
      // this number costs nothing (D-085).
      [rows, unread] = await Promise.all([
        loadInboxRows(viewer.id, includeRead),
        inboxBadge(viewer.id).then((count) => count ?? 0),
      ]);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // Outside the try on purpose: `redirect` signals by throwing, and the catch
  // above would turn it into an error message on a page nobody should reach.
  if (!viewer) redirect("/login");

  if (error || !rows) {
    // There is no filter link to blame here — the only parameter this page
    // takes cannot be malformed, it is either "1" or it is not.
    return <LoadFailure badLink={false} clearTo="/inbox" error={error} />;
  }

  const users = await listSwitchableUsers();

  // No `location`: the inbox is not looking at a list, and saying so is what
  // keeps the breadcrumb and the sidebar honest (D-086).
  const chrome: ShellChrome = { workspaceName, active: "inbox", viewer, users };

  return (
    <AppShell chrome={chrome} crumb={<strong>Inbox</strong>}>
      <Inbox rows={rows} unread={unread} includeRead={includeRead} />

      <FooterNote>
        {includeRead ? "everything you have been sent" : "unread only"} · direct signals
        only — assigned, mentioned and replied · acting as {viewer.name}
      </FooterNote>
    </AppShell>
  );
}
