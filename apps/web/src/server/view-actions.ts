"use server";

import type { ViewDefinition, ViewType } from "@arbor/core";
import {
  createView,
  deleteView,
  duplicateView,
  renameView,
  setDefaultView,
  updateViewDefinition,
} from "@arbor/db";
import { revalidatePath } from "next/cache";

import { requireUser } from "./auth";
import { requireWorkspace } from "./workspace";

/**
 * Saved-view actions.
 *
 * Same boundary rule as the configuration actions: build arguments, call a
 * service, never write SQL. And the same result shape (D-047) — every failure
 * here is one a user is expected to hit ("that view will not compile", "this is
 * the only view here"), so it comes back as a value the screen can render
 * beside the control rather than an exception that replaces it.
 */

export type ViewResult = { ok: true; id?: string } | { ok: false; error: string };

function failed(error: unknown): ViewResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function refresh() {
  revalidatePath("/");
  revalidatePath("/board");
}

async function actor() {
  const user = await requireUser();
  return { actorId: user.id };
}

export async function saveViewDefinitionAction(
  viewId: string,
  definition: ViewDefinition,
): Promise<ViewResult> {
  try {
    await updateViewDefinition(viewId, definition, await actor());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function createViewAction(
  listId: string,
  name: string,
  type: ViewType,
  definition: ViewDefinition,
  personal: boolean,
): Promise<ViewResult> {
  try {
    const [workspace, user] = await Promise.all([requireWorkspace(), requireUser()]);
    const view = await createView(
      { workspaceId: workspace.id, parentId: listId, type, name, definition, ownerId: personal ? user.id : null },
      { actorId: user.id },
    );
    refresh();
    return { ok: true, id: view.id };
  } catch (error) {
    return failed(error);
  }
}

export async function duplicateViewAction(
  viewId: string,
  name: string,
  definition: ViewDefinition,
  personal: boolean,
): Promise<ViewResult> {
  try {
    const user = await requireUser();
    const view = await duplicateView(viewId, name, { actorId: user.id }, {
      definition,
      ownerId: personal ? user.id : null,
    });
    refresh();
    return { ok: true, id: view.id };
  } catch (error) {
    return failed(error);
  }
}

export async function renameViewAction(viewId: string, name: string): Promise<ViewResult> {
  try {
    await renameView(viewId, name, await actor());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function setDefaultViewAction(viewId: string): Promise<ViewResult> {
  try {
    await setDefaultView(viewId, await actor());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function deleteViewAction(viewId: string): Promise<ViewResult> {
  try {
    await deleteView(viewId, await actor());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}
