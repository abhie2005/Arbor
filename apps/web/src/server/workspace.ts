import "server-only";

import { type WorkspaceMembership, workspacesFor } from "@arbor/db";
import { cookies } from "next/headers";
import { cache } from "react";

import { getCurrentUser } from "./auth";

/**
 * Which workspace this request is in.
 *
 * It used to be `WHERE slug = 'northwind'` — the seeded demo, looked up the
 * same way for everybody — with a comment promising the swap to "the workspace
 * this request belongs to" when real auth arrived. Sessions arrived in Phase 9
 * and the swap did not, so **a member of any workspace but Northwind could not
 * reach theirs** (D-137): Quinn, who is in Meridian and nothing else, landed on
 * Northwind with an empty list, the access index correctly refusing them inside
 * a workspace they are not in. Found by a browser pass, because a screen is the
 * only reader that has to *infer* which workspace it is in — every gate names
 * one, so nothing else could have caught it.
 *
 * **Resolution is the viewer's memberships, narrowed by a cookie.** A
 * membership is the only honest source: a grant is about a container inside a
 * workspace and so presupposes the answer. The cookie exists because
 * memberships alone do not answer it — Sam is in both — and D-137 is why it is
 * a cookie rather than a path segment or a stored preference.
 *
 * - **The cookie is a narrowing, never a grant.** It is checked against the
 *   viewer's own memberships on every read, so a hand-edited cookie naming
 *   somebody else's workspace resolves to the viewer's first one rather than to
 *   what it names. There is nothing to authorize here, because the cookie
 *   cannot widen anything.
 * - **The fallback is the first membership by `joined_at`**, which is stable
 *   across requests and across processes. "Whichever row came back first" would
 *   mean a reload could move you.
 *
 * All 27 callers are unchanged, because the signature is. That is the whole
 * reason this was a function and not a constant.
 */

export const WORKSPACE_COOKIE = "arbor_workspace";

export interface WorkspaceContext {
  id: string;
  name: string;
}

/**
 * Every workspace the viewer is in — for the shell's switcher, and for
 * validating a choice against something.
 *
 * `cache`d per request: the shell and the page both ask, and inside one render
 * it is the same question with the same answer (the pattern `inboxBadge`
 * already uses).
 */
export const viewerWorkspaces = cache(async (): Promise<WorkspaceMembership[]> => {
  const viewer = await getCurrentUser();
  if (!viewer) return [];
  return workspacesFor(viewer.id);
});

export const currentWorkspace = cache(async (): Promise<WorkspaceContext | null> => {
  const mine = await viewerWorkspaces();
  if (mine.length === 0) return null;

  const chosen = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const match = mine.find((workspace) => workspace.id === chosen);

  return match ?? mine[0]!;
});

export async function requireWorkspace(): Promise<WorkspaceContext> {
  const workspace = await currentWorkspace();
  if (workspace) return workspace;

  // Two genuinely different failures, where the old message named only the
  // second: a fresh browser is signed out, which every screen answers with a
  // redirect to `/login` rather than with this.
  const viewer = await getCurrentUser();
  throw new Error(
    viewer
      ? `${viewer.name} is not a member of any workspace.`
      : "Not signed in. Run `npm run db:seed` if the demo workspace is missing.",
  );
}
