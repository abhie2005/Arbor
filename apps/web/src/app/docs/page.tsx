import { AppShell, FooterNote, LoadFailure, type ShellChrome } from "@/components/app-shell";
import { Docs } from "@/components/docs";
import { getCurrentUser, listSwitchableUsers } from "@/server/auth";
import { loadDocsPage } from "@/server/docs";
import { requireWorkspace } from "@/server/workspace";
import { workspaceRole } from "@arbor/db";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * `/docs` — the fourth screen not scoped to one container, and the first whose
 * content is a CRDT.
 *
 * **Permission-scoped per page, not per screen.** A document hangs off any
 * container, so the list is one `access_index` join (D-111) — which is a
 * question the index could not answer before it held container rows (D-108).
 * The screen itself is open to every member; what is on it is not.
 */
export default async function DocsPage({
  searchParams,
}: {
  searchParams: Promise<{ doc?: string }>;
}) {
  const { doc } = await searchParams;

  let viewer: Awaited<ReturnType<typeof getCurrentUser>> = null;
  let page: Awaited<ReturnType<typeof loadDocsPage>> | null = null;
  let workspaceName = "";
  let error: string | null = null;

  try {
    viewer = await getCurrentUser();
    if (viewer) {
      const workspace = await requireWorkspace();
      workspaceName = workspace.name;

      const role = await workspaceRole(workspace.id, viewer.id);
      const isAdmin = role === "admin" || role === "owner";

      page = await loadDocsPage(workspace.id, viewer.id, doc ?? null, isAdmin);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // Outside the try: `redirect` signals by throwing, and the catch would turn
  // it into an error message on a page nobody should reach.
  if (!viewer) redirect("/login");

  if (error || !page) {
    return <LoadFailure badLink={Boolean(doc)} clearTo="/docs" error={error} />;
  }

  const users = await listSwitchableUsers();
  const chrome: ShellChrome = { workspaceName, active: "docs", viewer, users };

  return (
    <AppShell chrome={chrome} crumb={<strong>Docs</strong>}>
      <Docs
        docs={page.docs}
        places={page.places}
        open={page.open}
        viewerId={viewer.id}
        canCreateWorkspaceWide={page.canCreateWorkspaceWide}
        people={page.people}
      />

      <FooterNote>
        {page.docs.length} {page.docs.length === 1 ? "page" : "pages"} you can reach · edits merge
        as they arrive · acting as {viewer.name}
      </FooterNote>
    </AppShell>
  );
}
