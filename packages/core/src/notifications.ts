import type { Operation } from "./mutations";
import { mentionedIds } from "./richtext";

/**
 * Who an operation notifies.
 *
 * **The split this file implements is the schema's, not a new idea.** The
 * `notifications` table exists for *direct signals only* — you were assigned,
 * you were named, someone answered you. Everything else a watcher might want to
 * know is aggregated at read time from `activity`, because a task with two
 * hundred watchers would otherwise write two hundred rows every time somebody
 * changed its due date. So this returns a handful of people or none, and never
 * a watcher list.
 *
 * It is pure, and it takes the facts it cannot derive as context: who the actor
 * is, who wrote the comment being replied to, who a description already
 * mentioned before this edit. That keeps "who should hear about this" testable
 * without a database, which matters because the rule is small, easy to get
 * subtly wrong, and invisible when it is — a notification that should have been
 * sent and was not leaves no trace anywhere.
 */

export const NOTIFICATION_KINDS = ["assigned", "mentioned", "replied"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationTarget {
  userId: string;
  kind: NotificationKind;
}

export interface FanOutContext {
  /** Never notified about their own action. */
  actorId: string;
  /** The author of the comment a reply answers, when the operation is a reply. */
  parentAuthorId?: string | null;
  /**
   * Who the description already named before this edit.
   *
   * A description is saved repeatedly while it is being written, and every save
   * carries every mention in it. Without this, adding a sentence to a paragraph
   * that names three people notifies all three again.
   */
  previouslyMentioned?: readonly string[];
}

export function recipientsFor(
  op: Operation,
  context: FanOutContext,
): NotificationTarget[] {
  const targets = new Map<string, NotificationKind>();

  /** First kind wins: being mentioned in the reply that answers you is one event. */
  const add = (userId: string | null | undefined, kind: NotificationKind) => {
    if (!userId || userId === context.actorId || targets.has(userId)) return;
    targets.set(userId, kind);
  };

  switch (op.kind) {
    case "addRelation":
      // Assigning yourself is not news. Watchers are not notified here — that
      // is the ambient half, read from `activity`.
      if (op.relation === "assignee") add(op.targetId, "assigned");
      break;

    case "createComment": {
      // Mentions before the reply, so someone both named and answered hears
      // about it once, as the more specific of the two.
      for (const userId of mentionedIds(op.body)) add(userId, "mentioned");
      if (op.parentId) add(context.parentAuthorId, "replied");
      break;
    }

    case "editComment": {
      // Only people the edit *added*. Fixing a typo in a comment that names
      // four people is not four notifications.
      const before = new Set(mentionedIds(op.from));
      for (const userId of mentionedIds(op.to)) {
        if (!before.has(userId)) add(userId, "mentioned");
      }
      break;
    }

    case "setDescription": {
      const before = new Set(context.previouslyMentioned ?? []);
      if (op.to) {
        for (const userId of mentionedIds(op.to)) {
          if (!before.has(userId)) add(userId, "mentioned");
        }
      }
      break;
    }

    default:
      // Status, priority, dates, order, archiving, deleting a comment. All
      // real events, none of them addressed to anyone in particular — they
      // belong to the read-time aggregation over `activity`.
      break;
  }

  return [...targets].map(([userId, kind]) => ({ userId, kind }));
}
