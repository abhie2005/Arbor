"use server";

import {
  createApiToken,
  loadApiToken,
  requireContainerAccess,
  revokeApiToken,
} from "@arbor/db";
import { revalidatePath } from "next/cache";

import { requireUser } from "./auth";
import { requireWorkspace } from "./workspace";

/**
 * Minting and revoking API tokens (D-135).
 *
 * **`manage` on the container, not a workspace role** — the same answer the
 * automations actions give (D-129), because a token is the same shape of thing:
 * scoped to one container, acting only inside it, which makes it sharing
 * (D-109) rather than workspace-wide configuration (D-081). A member holds
 * `edit` at most and so cannot mint one; an admin has no `manage` on a private
 * space they were never granted and so cannot mint one that reads it.
 *
 * It is the same check `createApiToken` already relies on being made — the
 * service writes the grant that gives the token its reach, so an unauthorized
 * mint would be an unauthorized *grant*.
 */

export type TokenResult =
  | { ok: true }
  | { ok: true; token: string; name: string; prefix: string }
  | { ok: false; error: string };

function failed(error: unknown): TokenResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function refresh() {
  revalidatePath("/settings/api");
}

export async function createApiTokenAction(input: {
  containerId: string;
  name: string;
  permission: "view" | "comment" | "edit" | "manage";
  expiresInDays?: number;
}): Promise<TokenResult> {
  try {
    const workspace = await requireWorkspace();
    const actor = await requireUser();
    await requireContainerAccess(input.containerId, actor.id, "manage");

    const created = await createApiToken(
      {
        workspaceId: workspace.id,
        name: input.name,
        containerId: input.containerId,
        permission: input.permission,
        expiresInDays: input.expiresInDays,
      },
      { actorId: actor.id },
    );

    refresh();

    /**
     * **The one time the token leaves the server.**
     *
     * Stored as a hash, so there is no second chance to show it (D-133) — and
     * no revalidation can bring it back, which is why it travels in this
     * return value rather than being read off the page after a refresh.
     */
    return {
      ok: true,
      token: created.token,
      name: created.record.name,
      prefix: created.record.prefix,
    };
  } catch (error) {
    return failed(error);
  }
}

export async function revokeApiTokenAction(tokenId: string): Promise<TokenResult> {
  try {
    const workspace = await requireWorkspace();
    const actor = await requireUser();

    // The container comes off the token, never from the request.
    const token = await loadApiToken(tokenId);
    if (!token || token.workspaceId !== workspace.id) {
      throw new Error("That token no longer exists");
    }

    await requireContainerAccess(token.containerId, actor.id, "manage");
    await revokeApiToken(tokenId, workspace.id, { actorId: actor.id });

    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}
