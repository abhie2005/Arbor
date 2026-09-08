"use server";

import { randomUUID } from "node:crypto";

import { type Operation, mentionedIds, parseRichText, parseStoredDoc } from "@arbor/core";
import {
  applyOperations,
  commentOwnership,
  grantAccess,
  pool,
  requireTaskAccess,
  requireWorkspaceRole,
} from "@arbor/db";
import { revalidatePath } from "next/cache";

import { requireUser } from "./auth";

/**
 * Comment actions.
 *
 * Same boundary rule as every other action file: build operations, hand them to
 * `applyOperations`, never write SQL. Comments are operations (D-083), so the
 * activity row and a working undo arrive without this file doing anything for
 * them.
 *
 * **The one thing here that is not a comment concern is sharing.** Mentioning
 * someone who cannot see the task produces a notification pointing at a page
 * that will tell them it does not exist. The answer is to offer access — but
 * offering it is a permission change, and a permission change that happens
 * because someone typed an "@" is a permission change nobody agreed to. So the
 * post is refused once, with the names, and repeated with consent (D-084).
 */

export interface MentionBlock {
  ok: false;
  needsConsent: true;
  /** People named in the comment who cannot open the task. */
  unreachable: { id: string; name: string }[];
  /** The container access would be granted on — the smallest one that works. */
  listName: string;
  /** False when the author cannot share it either, so consent would not help. */
  canShare: boolean;
}

export type CommentResult = { ok: true; operations: Operation[] } | MentionBlock;

/**
 * Posts a comment, or refuses and says who cannot see it.
 *
 * `share` is the consent: the same call, made again, after the author has been
 * told what it would do. It is a separate argument rather than a flag the
 * client can set by default, because the whole point is that the second call
 * is a different act from the first.
 */
export async function postComment(
  taskId: string,
  text: string,
  parentId: string | null,
  share = false,
): Promise<CommentResult> {
  const actor = await requireUser();
  const access = await requireTaskAccess(taskId, actor.id, "edit");

  const people = await pool().query<{ id: string; name: string }>(
    `SELECT id, name FROM users WHERE deactivated_at IS NULL`,
  );

  const body = parseRichText(text, people.rows);
  if (body.content.length === 0) throw new Error("A comment needs something in it");

  const mentioned = mentionedIds(body).filter((id) => id !== actor.id);

  // One query for everyone named, rather than one per mention.
  const reachable = new Set(
    (
      await pool().query<{ principal_id: string }>(
        `SELECT principal_id FROM access_index WHERE list_id = $1 AND principal_id = ANY($2::uuid[])`,
        [access.homeListId, mentioned],
      )
    ).rows.map((row) => row.principal_id),
  );

  const unreachable = people.rows.filter(
    (person) => mentioned.includes(person.id) && !reachable.has(person.id),
  );

  if (unreachable.length > 0) {
    // Granting is administration (D-081), so whether consent would even help
    // is settled before asking for it.
    const canShare = await isAdmin(access.workspaceId, actor.id);

    if (!share || !canShare) {
      const list = await pool().query<{ name: string }>(
        `SELECT name FROM containers WHERE id = $1`,
        [access.homeListId],
      );

      return {
        ok: false,
        needsConsent: true,
        unreachable: unreachable.map((person) => ({ id: person.id, name: person.name })),
        listName: list.rows[0]?.name ?? "this list",
        canShare,
      };
    }

    // The list, not the space (D-084): the smallest container that makes this
    // task reachable. Mentioning someone on one task should not open every
    // other list in the space they have never been shown.
    for (const person of unreachable) {
      await grantAccess(
        {
          containerId: access.homeListId,
          principalKind: "user",
          principalId: person.id,
          permission: "view",
        },
        { actorId: actor.id },
      );
    }
  }

  const commentId = randomUUID();

  await applyOperations([{ kind: "createComment", commentId, taskId, body, parentId }], {
    actorId: actor.id,
  });

  // Whoever comments is watching it now — the fan-out that Phase 7's next pass
  // reads is `task_watchers`, and someone who has joined a conversation has
  // opted into it more clearly than anyone the system could infer.
  await applyOperations(
    [{ kind: "addRelation", taskId, relation: "watcher", targetId: actor.id }],
    { actorId: actor.id },
  ).catch(() => {
    // Already watching. Never a reason to fail the comment.
  });

  revalidatePath("/", "layout");

  return { ok: true, operations: [{ kind: "deleteComment", commentId, taskId }] };
}

/**
 * Edits a comment.
 *
 * **Only the author.** Someone with `edit` on the list may change everything
 * else on this task; they may not rewrite what another person said, because a
 * comment records that a person said a thing and an edit by anyone else makes
 * the record false. Being the author is checked *as well as* list access, not
 * instead of it — an author who has since lost access to the list has lost it.
 */
export async function editComment(commentId: string, text: string): Promise<Operation[]> {
  const actor = await requireUser();
  const owned = await requireOwnComment(commentId, actor.id);

  const people = await pool().query<{ id: string; name: string }>(
    `SELECT id, name FROM users WHERE deactivated_at IS NULL`,
  );

  const to = parseRichText(text, people.rows);
  if (to.content.length === 0) throw new Error("A comment needs something in it");

  const current = await pool().query<{ body: unknown }>(
    `SELECT body FROM comments WHERE id = $1`,
    [commentId],
  );

  const from = parseStoredDoc(current.rows[0]?.body) ?? { type: "doc" as const, content: [] };

  const op: Operation = { kind: "editComment", commentId, taskId: owned.taskId, from, to };
  await applyOperations([op], { actorId: actor.id });
  revalidatePath("/", "layout");

  return [{ ...op, from: to, to: from }];
}

/** Deletes a comment. Soft, so the replies under it keep their anchor (D-083). */
export async function deleteComment(commentId: string): Promise<Operation[]> {
  const actor = await requireUser();
  const owned = await requireOwnComment(commentId, actor.id);

  await applyOperations([{ kind: "deleteComment", commentId, taskId: owned.taskId }], {
    actorId: actor.id,
  });
  revalidatePath("/", "layout");

  return [{ kind: "restoreComment", commentId, taskId: owned.taskId }];
}

async function requireOwnComment(
  commentId: string,
  actorId: string,
): Promise<{ taskId: string }> {
  const owned = await commentOwnership(commentId);
  if (!owned) throw new Error("That comment no longer exists");

  // The list first: a comment on a task you can no longer reach is not yours to
  // change, whoever wrote it.
  await requireTaskAccess(owned.taskId, actorId, "edit");

  if (owned.authorId !== actorId) throw new Error("Only the author can change a comment");
  return { taskId: owned.taskId };
}

async function isAdmin(workspaceId: string, userId: string): Promise<boolean> {
  try {
    await requireWorkspaceRole(workspaceId, userId, "admin");
    return true;
  } catch {
    return false;
  }
}
