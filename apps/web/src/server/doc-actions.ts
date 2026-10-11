"use server";

import { diffFor } from "@arbor/core";
import {
  applyDocumentUpdate,
  archiveDoc,
  createDoc,
  loadDoc,
  moveDoc,
  renameDoc,
  requireContainerAccess,
  requireWorkspaceRole,
} from "@arbor/db";
import { revalidatePath } from "next/cache";

import { requireUser } from "./auth";
import { requireWorkspace } from "./workspace";

/**
 * Document actions.
 *
 * **Editing a page takes `edit` on the container it lives in** — the same
 * permission adding a task to a list takes, asked of the same index (D-108).
 * A page on no container is workspace-wide, and takes the workspace role, which
 * is the rule a workspace-wide saved view already follows: there is nothing
 * smaller to scope it to (D-057).
 *
 * **These return nothing to undo**, like the goal and dashboard actions and for
 * a sharper reason: ⌘Z inside a document has to mean the text somebody just
 * typed, which is the editor's own history over the CRDT (D-111).
 *
 * `pushDocUpdate` is the odd one. It carries a Yjs update as base64, because a
 * server action's arguments are JSON and a `Uint8Array` does not survive that
 * trip — the invariant an operation learned by breaking (D-097). It is also the
 * only action in the app called on a timer rather than on a click.
 */

export type DocResult<T = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

function failed(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/**
 * May this person change this document?
 *
 * Reads the document as the viewer first, so an unreachable page and a missing
 * one are refused in the same words — a check that told them apart would say
 * which documents exist (invariant 6).
 */
async function editorOf(docId: string) {
  const actor = await requireUser();
  const doc = await loadDoc(docId, actor.id);
  if (!doc) throw new Error("That document no longer exists");

  if (doc.containerId) await requireContainerAccess(doc.containerId, actor.id, "edit");
  else await requireWorkspaceRole(doc.workspaceId, actor.id, "admin");

  return { actor, doc };
}

export async function createDocAction(
  containerId: string | null,
  title: string,
  parentPageId: string | null = null,
): Promise<DocResult<{ id: string }>> {
  try {
    const [actor, workspace] = await Promise.all([requireUser(), requireWorkspace()]);

    if (containerId) await requireContainerAccess(containerId, actor.id, "edit");
    else await requireWorkspaceRole(workspace.id, actor.id, "admin");

    // A subpage inherits its parent's container rather than being told one, so
    // the two cannot disagree — and the parent has to be reachable as the
    // viewer, or the id alone would say whether it exists (invariant 6).
    if (parentPageId) {
      const parent = await loadDoc(parentPageId, actor.id);
      if (!parent) throw new Error("That document no longer exists");
      if (parent.containerId !== containerId) {
        throw new Error("A subpage lives in the same container as the page above it");
      }
    }

    const doc = await createDoc(
      { workspaceId: workspace.id, containerId, parentPageId, title },
      { actorId: actor.id },
    );

    revalidatePath("/docs");
    return { ok: true, id: doc.id };
  } catch (error) {
    return failed(error);
  }
}

export async function renameDocAction(docId: string, title: string): Promise<DocResult> {
  try {
    const { actor } = await editorOf(docId);
    await renameDoc(docId, title, { actorId: actor.id });
    revalidatePath("/docs");
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function archiveDocAction(docId: string, archived: boolean): Promise<DocResult> {
  try {
    const { actor } = await editorOf(docId);
    await archiveDoc(docId, archived, { actorId: actor.id });
    revalidatePath("/docs");
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function moveDocAction(
  docId: string,
  containerId: string | null,
): Promise<DocResult> {
  try {
    const { actor } = await editorOf(docId);

    // Both ends, because a move is two permissions: leaving where it was and
    // arriving where it is going. `editorOf` covered the first.
    if (containerId) await requireContainerAccess(containerId, actor.id, "edit");
    else await requireWorkspaceRole((await requireWorkspace()).id, actor.id, "admin");

    await moveDoc(docId, { containerId }, { actorId: actor.id });
    revalidatePath("/docs");
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Where a page sits in the tree: under which page, and among which siblings.
 *
 * **Separate from `moveDocAction`, which moves between containers** (D-119).
 * They authorize differently and that is the whole reason: changing container
 * is a permission question about two containers, while dragging a page inside
 * one is a question about the container it is already in — which `editorOf`
 * has already answered. Folding both into one action would mean one argument
 * list where half the arguments decide which checks run.
 *
 * The new parent is checked for reachability as the viewer before it is used.
 * Without that, a client could post the id of a page in a space it cannot see
 * and learn whether it exists from whether the move succeeded (invariant 6).
 */
export async function repositionDocAction(
  docId: string,
  parentPageId: string | null,
  afterId: string | null,
): Promise<DocResult> {
  try {
    const { actor, doc } = await editorOf(docId);

    for (const other of [parentPageId, afterId]) {
      if (!other) continue;
      const target = await loadDoc(other, actor.id);
      if (!target) throw new Error("That document no longer exists");
      if (target.containerId !== doc.containerId) {
        throw new Error("A page can only be moved within the container it is in");
      }
    }

    await moveDoc(docId, { parentPageId, afterId }, { actorId: actor.id });
    revalidatePath("/docs");
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/**
 * One editing session's changes, folded into the stored document.
 *
 * **No `revalidatePath`.** Every other action in this app revalidates, because
 * every other action's result is something the server re-renders. This one's
 * result is already on the author's screen — they typed it — and a refresh
 * would tear down the editor holding their cursor. Other viewers hear about it
 * on the live stream and pull the difference (D-112).
 */
export async function pushDocUpdate(docId: string, update: string): Promise<DocResult> {
  try {
    const { actor } = await editorOf(docId);

    const bytes = Buffer.from(update, "base64");
    if (bytes.length === 0) throw new Error("That update is empty");

    await applyDocumentUpdate(docId, new Uint8Array(bytes), { actorId: actor.id });
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/**
 * What this client is missing, as base64.
 *
 * The answer to a nudge: the client sends the state vector it already has and
 * gets back only the difference, so a document edited for a year is not resent
 * to somebody who has been reading it all morning.
 */
export async function pullDocUpdate(
  docId: string,
  stateVector: string,
): Promise<DocResult<{ update: string }>> {
  try {
    const actor = await requireUser();
    const doc = await loadDoc(docId, actor.id);
    if (!doc) throw new Error("That document no longer exists");

    const diff = diffFor(doc.state, new Uint8Array(Buffer.from(stateVector, "base64")));

    return { ok: true, update: Buffer.from(diff).toString("base64") };
  } catch (error) {
    return failed(error);
  }
}
