"use server";

import type { Permission } from "@arbor/core";
import { grantAccess, rebuildAccessIndex, revokeAccess, setContainerPrivacy } from "@arbor/db";
import { revalidatePath } from "next/cache";

import { requireUser } from "./auth";
import { requireWorkspace } from "./workspace";

/**
 * Sharing server actions.
 *
 * Same boundary rule as the other action files: build arguments, call a
 * service, never write SQL. The rebuild happens inside the service's
 * transaction (D-071), so by the time one of these returns, the access index
 * already agrees with the grant.
 *
 * Every path revalidates every renderer, because a permission change can add
 * or remove whole lists from what the viewer sees — unlike a task edit, which
 * only changes a row.
 */

export type AccessResult = { ok: true } | { ok: false; error: string };

function failed(error: unknown): AccessResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function revalidateEverything() {
  for (const path of ["/", "/board", "/table", "/calendar", "/settings/sharing"]) {
    revalidatePath(path);
  }
}

export async function shareContainerAction(
  containerId: string,
  principalKind: "user" | "group",
  principalId: string,
  permission: Permission,
): Promise<AccessResult> {
  try {
    const actor = await requireUser();
    await grantAccess(
      { containerId, principalKind, principalId, permission },
      { actorId: actor.id },
    );
    revalidateEverything();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function unshareContainerAction(
  containerId: string,
  principalKind: "user" | "group",
  principalId: string,
): Promise<AccessResult> {
  try {
    const actor = await requireUser();
    await revokeAccess(containerId, principalKind, principalId, { actorId: actor.id });
    revalidateEverything();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function setPrivacyAction(
  containerId: string,
  isPrivate: boolean,
): Promise<AccessResult> {
  try {
    const actor = await requireUser();
    await setContainerPrivacy(containerId, isPrivate, { actorId: actor.id });
    revalidateEverything();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Recomputes the index by hand.
 *
 * The rebuild is idempotent, so this is safe to press at any time. It exists
 * because the index is derived data: if it is ever wrong, the fix is to
 * recompute it, and having that as a button beats having it as a note in a
 * runbook. It is also what the worker will call once there is a worker.
 */
export async function rebuildAccessAction(): Promise<AccessResult> {
  try {
    await requireUser();
    const workspace = await requireWorkspace();
    await rebuildAccessIndex(workspace.id);
    revalidateEverything();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}
