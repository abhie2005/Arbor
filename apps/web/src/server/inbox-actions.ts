"use server";

import { markActivitySeen, markAllRead, markRead } from "@arbor/db";
import { revalidatePath } from "next/cache";

import { requireUser } from "./auth";
import { requireWorkspace } from "./workspace";

/**
 * Marking notifications read.
 *
 * **These are the first writes that are deliberately not operations** (D-087).
 * Everything that changes the workspace goes through `applyOperations` so the
 * activity log and undo come free — but read state is not the workspace. It is
 * one person's view of it: nobody else can observe it, "Avery marked a
 * notification read" is noise in a log meant to answer what happened to the
 * work, and ⌘Z restoring a bold row is not a feature anyone wants. Sessions
 * already write outside the executor for the same reason.
 *
 * Authorization is in the queries and not repeated here: both are scoped by
 * `user_id`, so an id belonging to someone else updates nothing rather than
 * being refused. That is the right shape — an inbox that says "that is not
 * yours" for an id you guessed has confirmed the id exists.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function markNotificationRead(notificationId: string): Promise<void> {
  const actor = await requireUser();

  // Checked before it reaches Postgres: a malformed id is a client bug, and
  // `invalid input syntax for type uuid` is not a sentence to show anyone.
  if (!UUID_RE.test(notificationId)) throw new Error("That notification no longer exists");

  await markRead(notificationId, actor.id);

  // The badge is in the chrome of every screen, so the layout is what goes
  // stale — not just this page.
  revalidatePath("/", "layout");
}

/**
 * Clears both halves, because the button says "all".
 *
 * The two are cleared by different mechanisms — a flag per row for the signals
 * written to you, one timestamp for the activity assembled from what you watch
 * — and that difference is the schema's, not something a person operating this
 * screen should have to hold. An inbox with one button that empties half of
 * itself is worse than an inbox with two buttons.
 */
export async function markEverythingRead(): Promise<number> {
  const actor = await requireUser();
  const workspace = await requireWorkspace();

  const cleared = await markAllRead(actor.id);
  await markActivitySeen(actor.id, workspace.id);

  revalidatePath("/", "layout");
  return cleared;
}
