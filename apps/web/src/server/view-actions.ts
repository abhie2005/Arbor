"use server";

import type { ViewDefinition, ViewType } from "@arbor/core";
import {
  createView,
  deleteView,
  duplicateView,
  pool,
  renameView,
  requireListAccess,
  requireViewAccess,
  setDefaultView,
  taskAccess,
  updateViewDefinition,
} from "@arbor/db";
import { revalidatePath } from "next/cache";

import { requireUser } from "./auth";
import { loadSearch } from "./search";
import { requireWorkspace } from "./workspace";

/**
 * Saved-view actions.
 *
 * Same boundary rule as the configuration actions: build arguments, call a
 * service, never write SQL. And the same result shape (D-047) — every failure
 * here is one a user is expected to hit ("that view will not compile", "this is
 * the only view here"), so it comes back as a value the screen can render
 * beside the control rather than an exception that replaces it.
 *
 * **A view is authorized as two different things** (D-081). A personal view is
 * one person's and nobody else may touch it — a shared view is part of the
 * container and takes the container's `edit`. `requireViewAccess` decides
 * which by looking at `ownerId`, so no action here has to remember the
 * distinction.
 */

export type ViewResult = { ok: true; id?: string } | { ok: false; error: string };

function failed(error: unknown): ViewResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function refresh() {
  revalidatePath("/");
  revalidatePath("/board");
}

/**
 * The actor, having established they may change this particular view.
 *
 * Returning the config object the services take means an action cannot get the
 * actor without also having been checked — the check is not something a new
 * action can forget to add, because there is no other way to get the argument
 * it needs.
 */
async function actorFor(viewId: string) {
  const user = await requireUser();
  await requireViewAccess(viewId, user.id);
  return { actorId: user.id };
}

export async function saveViewDefinitionAction(
  viewId: string,
  definition: ViewDefinition,
): Promise<ViewResult> {
  try {
    await updateViewDefinition(viewId, definition, await actorFor(viewId));
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
    // A container, not a view — there is no view yet to check against.
    await requireListAccess(listId, user.id, "edit");
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
    await requireViewAccess(viewId, user.id);
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
    await renameView(viewId, name, await actorFor(viewId));
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function setDefaultViewAction(viewId: string): Promise<ViewResult> {
  try {
    await setDefaultView(viewId, await actorFor(viewId));
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function deleteViewAction(viewId: string): Promise<ViewResult> {
  try {
    await deleteView(viewId, await actorFor(viewId));
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/**
 * The two halves of the one picker that cannot be a menu (D-149).
 *
 * Every other value control is a closed set shipped with the page —
 * `loadFilterOptions` loads the statuses, the people, the lists. A task cannot
 * be: a workspace has thousands, and sending them all so that somebody can
 * filter on one is a page load paying for an interaction most readers never
 * start. That is the same reasoning `linkCandidates` is built on (D-120), and
 * these live here rather than there because the control belongs to the filter
 * bar, which the automation form borrows (D-129).
 *
 * **Searching goes through `loadSearch`**, so the picker matches the way
 * `/search` matches — one rule for what matches, invariant 15 — and inherits
 * its permission scoping rather than repeating it.
 */
export type TaskOption = { id: string; label: string; hint: string };

export async function taskCandidates(
  term: string,
): Promise<{ ok: true; tasks: TaskOption[] } | { ok: false; error: string }> {
  try {
    const [actor, workspace] = await Promise.all([requireUser(), requireWorkspace()]);

    const trimmed = term.trim();
    if (trimmed === "") return { ok: true, tasks: [] };

    const results = await loadSearch(workspace.id, actor.id, trimmed);

    return {
      ok: true,
      tasks: results.tasks.slice(0, 8).map((task) => ({
        id: task.id,
        // The key is what somebody means by "this task", and the name is what
        // tells them they picked the right one.
        label: task.key ?? task.name,
        hint: task.name,
      })),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * What the ids a filter already holds are called.
 *
 * A stored condition is a uuid, and a box showing one is the gap this closes —
 * so the control asks what it is looking at. Read by hand with an access check
 * in front of it rather than through the compiler, which is the detail page's
 * bargain for the same reason: this is a handful of tasks by id, not a page of
 * them (invariant 5).
 *
 * **An id the viewer cannot reach comes back as nothing**, which reads as
 * "no longer exists" — the same words a genuinely missing task gets, because a
 * picker that said "you may not see this one" would be an existence oracle
 * (invariant 6).
 */
export async function namedTasks(
  ids: string[],
): Promise<{ ok: true; tasks: TaskOption[] } | { ok: false; error: string }> {
  try {
    const actor = await requireUser();

    const wanted = [...new Set(ids.filter((id) => typeof id === "string" && id !== ""))].slice(0, 20);
    if (wanted.length === 0) return { ok: true, tasks: [] };

    const reachable = await Promise.all(
      wanted.map(async (id) => ((await taskAccess(id, actor.id)) ? id : null)),
    );
    const allowed = reachable.filter((id): id is string => id !== null);
    if (allowed.length === 0) return { ok: true, tasks: [] };

    const rows = await pool().query<{ id: string; key: string | null; name: string }>(
      `SELECT id, key, name FROM tasks WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [allowed],
    );

    return {
      ok: true,
      tasks: rows.rows.map((row) => ({ id: row.id, label: row.key ?? row.name, hint: row.name })),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
