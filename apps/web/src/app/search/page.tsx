import { AppShell, FooterNote, LoadFailure, type ShellChrome } from "@/components/app-shell";
import { SearchResultsList } from "@/components/search-results";
import { getCurrentUser, listSwitchableUsers } from "@/server/auth";
import { loadSearch } from "@/server/search";
import { requireWorkspace } from "@/server/workspace";
import { parseQuery } from "@arbor/core";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * `/search` — the screen that finally reads `docs.search_text`.
 *
 * **A GET, not a server action.** The query is in the URL, which makes a search
 * a link somebody can send and the back button work (D-049); and a read that
 * authorizes by scoping its joins needs no write boundary to guard. There is no
 * `search-actions.ts`, deliberately — a `"use server"` function here would be a
 * POST that returns what a URL already describes.
 *
 * **Permission-scoped by the two loaders**, not by this page. Tasks come
 * through the compiler's `access_index` join, pages through the reachability
 * clause they share with `/docs` (D-113). The screen is open to every member;
 * what is on it is not.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const term = parseQuery(q);

  let viewer: Awaited<ReturnType<typeof getCurrentUser>> = null;
  let results: Awaited<ReturnType<typeof loadSearch>> | null = null;
  let workspaceName = "";
  let error: string | null = null;

  try {
    viewer = await getCurrentUser();
    if (viewer) {
      const workspace = await requireWorkspace();
      workspaceName = workspace.name;

      // No term, no query. `ILIKE '%%'` matches every row, so an empty search
      // is the most expensive one in the app rather than the cheapest.
      if (term) results = await loadSearch(workspace.id, viewer.id, term);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (!viewer) redirect("/login");

  if (error) {
    return <LoadFailure badLink={Boolean(q)} clearTo="/search" error={error} />;
  }

  const users = await listSwitchableUsers();
  const chrome: ShellChrome = { workspaceName, active: "search", viewer, users, query: term ?? "" };

  return (
    <AppShell chrome={chrome} crumb={<strong>Search</strong>}>
      {results ? (
        <SearchResultsList results={results} />
      ) : (
        <div className="search-empty">
          <p>Search this workspace.</p>
          <p className="search-empty-hint">
            Task names, page titles and page text. Only what you can reach — a private space you
            have no grant on does not appear, and does not say that it did not.
          </p>
        </div>
      )}

      <FooterNote>
        {results
          ? `${results.tasks.length} ${results.tasks.length === 1 ? "task" : "tasks"} · ${
              results.docs.length
            } ${results.docs.length === 1 ? "page" : "pages"} · matching is case-insensitive substring`
          : "acting as " + viewer.name}
      </FooterNote>
    </AppShell>
  );
}
