/**
 * Mutations as invertible operations.
 *
 * Every change to a task is described as a value before applying it. That single
 * constraint buys three things that are extremely hard to retrofit:
 *
 * 1. **Undo.** `invert(op)` is a pure function. `⌘Z` reverses any mutation,
 *    including bulk ones, because a bulk edit is just an array of operations
 *    inverted in reverse order.
 * 2. **The activity log.** Every operation already carries `from` and `to`, so
 *    the log row writes itself rather than being assembled by hand at each call
 *    site — which is how field changes silently stop being recorded.
 * 3. **Optimistic UI.** The client applies the operation to its cache
 *    immediately and rolls back by applying the inverse if the server rejects it.
 *
 * This module is pure: no database, no network. The executor in the app layer
 * turns an operation into SQL and an activity row.
 */

import { type RichDoc, renderPlain } from "./richtext";

export type TaskField =
  | "name"
  | "statusId"
  | "priority"
  | "dueAt"
  | "startAt"
  | "points"
  | "timeEstimateMs"
  | "parentTaskId"
  | "homeListId"
  | "taskTypeId"
  | "position";

/** A scalar field assignment. The workhorse — status, priority, dates, name. */
export interface SetFieldOp {
  kind: "setField";
  taskId: string;
  field: TaskField;
  from: unknown;
  to: unknown;
}

/** A custom field value. Separate because it targets `field_values`, not `tasks`. */
export interface SetCustomFieldOp {
  kind: "setCustomField";
  taskId: string;
  fieldId: string;
  from: unknown;
  to: unknown;
}

/** Set membership: assignees, watchers, tags. Add and remove are symmetric. */
export interface RelationOp {
  kind: "addRelation" | "removeRelation";
  taskId: string;
  relation: "assignee" | "watcher" | "tag";
  targetId: string;
}

export interface CreateTaskOp {
  kind: "createTask";
  taskId: string;
  listId: string;
  values: Record<string, unknown>;
}

/**
 * Archive rather than delete (D-015). Inverts cleanly, which a hard delete
 * could not — you cannot un-delete a row you no longer have.
 */
export interface ArchiveOp {
  kind: "archiveTask" | "restoreTask";
  taskId: string;
}

/**
 * A comment, as an operation.
 *
 * **Comments could have been written directly and were not.** A comment service
 * inserting a row and logging its own activity would work, and it would make
 * `applyOperations` no longer the only thing that writes — which is the
 * property keeping the activity log complete by construction, and the reason
 * undo needed no per-feature work for five phases. The second writer is always
 * the one that forgets to log.
 *
 * The consequence is that ⌘Z removes a comment you just posted. That is a
 * surprise the first time and the honest one: it *was* the last thing you did.
 *
 * `taskId` is on every one of these even though `commentId` identifies the row,
 * because it is what authorization is scoped to — `undo` takes operations from
 * the client and maps them to task ids to check (D-080). An operation whose
 * target could not be checked would be a hole in that.
 */
export interface CreateCommentOp {
  kind: "createComment";
  commentId: string;
  taskId: string;
  body: RichDoc;
  /** Null for a top-level comment; a comment id for a reply. */
  parentId: string | null;
}

/** Soft, like archiving a task, and for the same reason: it inverts (D-015). */
export interface CommentLifecycleOp {
  kind: "deleteComment" | "restoreComment";
  commentId: string;
  taskId: string;
}

/**
 * A task's description.
 *
 * Not a `setField`: that map is closed to scalar columns on `tasks` and this is
 * a document that has to be validated as a tree before it is written. Its own
 * operation rather than a direct UPDATE, because a direct UPDATE would be the
 * second thing in the system that writes — the exact thing comments were made
 * operations to avoid (D-083).
 */
export interface SetDescriptionOp {
  kind: "setDescription";
  taskId: string;
  from: RichDoc | null;
  to: RichDoc | null;
}

export interface EditCommentOp {
  kind: "editComment";
  commentId: string;
  taskId: string;
  from: RichDoc;
  to: RichDoc;
}

export type Operation =
  | SetFieldOp
  | SetCustomFieldOp
  | RelationOp
  | CreateTaskOp
  | ArchiveOp
  | CreateCommentOp
  | CommentLifecycleOp
  | EditCommentOp
  | SetDescriptionOp;

export class MutationError extends Error {}

/**
 * The inverse of an operation.
 *
 * `createTask` inverts to `archiveTask` rather than to a delete, so undoing a
 * creation is itself undoable and no data is destroyed.
 */
export function invert(op: Operation): Operation {
  switch (op.kind) {
    case "setField":
      return { ...op, from: op.to, to: op.from };

    case "setCustomField":
      return { ...op, from: op.to, to: op.from };

    case "addRelation":
      return { ...op, kind: "removeRelation" };

    case "removeRelation":
      return { ...op, kind: "addRelation" };

    case "createTask":
      return { kind: "archiveTask", taskId: op.taskId };

    case "archiveTask":
      return { kind: "restoreTask", taskId: op.taskId };

    case "restoreTask":
      return { kind: "archiveTask", taskId: op.taskId };

    // Deleting rather than hard-removing, so undoing an undo restores the
    // comment rather than losing what someone wrote.
    case "createComment":
      return { kind: "deleteComment", commentId: op.commentId, taskId: op.taskId };

    case "deleteComment":
      return { kind: "restoreComment", commentId: op.commentId, taskId: op.taskId };

    case "restoreComment":
      return { kind: "deleteComment", commentId: op.commentId, taskId: op.taskId };

    case "editComment":
      return { ...op, from: op.to, to: op.from };

    case "setDescription":
      return { ...op, from: op.to, to: op.from };

    default: {
      const exhaustive: never = op;
      throw new MutationError(`Cannot invert unknown operation: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * The inverse of a batch.
 *
 * Reversed order matters: operations in a batch can depend on each other, so
 * undoing them in the order they were applied can fail or produce the wrong
 * state. Undo runs the batch backwards.
 */
export function invertBatch(ops: readonly Operation[]): Operation[] {
  return [...ops].reverse().map(invert);
}

/** Verb recorded in the activity log for this operation. */
export function activityVerb(op: Operation): string {
  switch (op.kind) {
    case "setField":
      return `task.${camelToSnake(op.field)}_changed`;
    case "setCustomField":
      return "task.custom_field_changed";
    case "addRelation":
      return `task.${op.relation}_added`;
    case "removeRelation":
      return `task.${op.relation}_removed`;
    case "createTask":
      return "task.created";
    case "archiveTask":
      return "task.archived";
    case "restoreTask":
      return "task.restored";
    case "createComment":
      return "comment.added";
    case "deleteComment":
      return "comment.deleted";
    case "restoreComment":
      return "comment.restored";
    case "editComment":
      return "comment.edited";
    case "setDescription":
      return "task.description_changed";
    default: {
      const exhaustive: never = op;
      throw new MutationError(`No verb for operation: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Human-readable summary, used in the undo toast and the activity feed. */
export function describe(op: Operation): string {
  switch (op.kind) {
    case "setField":
      return `Changed ${humanize(op.field)}`;
    case "setCustomField":
      return "Changed a custom field";
    case "addRelation":
      return `Added ${op.relation}`;
    case "removeRelation":
      return `Removed ${op.relation}`;
    case "createTask":
      return "Created task";
    case "archiveTask":
      return "Archived task";
    case "restoreTask":
      return "Restored task";
    case "createComment":
      return "Posted a comment";
    case "deleteComment":
      return "Deleted a comment";
    case "restoreComment":
      return "Restored a comment";
    case "editComment":
      return "Edited a comment";
    case "setDescription":
      return "Changed the description";
    default: {
      const exhaustive: never = op;
      throw new MutationError(`No description for: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * What a batch did, for the undo toast and the activity feed.
 *
 * Counts **tasks, not operations**. Those are not the same number and the
 * difference is visible: one drag on the board is two operations — status and
 * order — against a single task, and this used to announce it as "Changed
 * order on 2 tasks". A bulk edit of two fields across three tasks would have
 * claimed six.
 *
 * Several changes to one task get their fields named instead of counted,
 * because "Changed status and order" is what actually happened and is shorter
 * than the wrong version was.
 */
export function describeBatch(ops: readonly Operation[]): string {
  if (ops.length === 0) return "Nothing to undo";
  if (ops.length === 1) return describe(ops[0]!);

  const first = ops[0]!;
  const taskCount = new Set(ops.map((op) => op.taskId)).size;

  if (taskCount === 1) {
    const fields = ops.filter(isSetField).map((op) => humanize(op.field));
    return fields.length === ops.length ? `Changed ${joinWords(fields)}` : `${ops.length} changes`;
  }

  const uniform = ops.every((op) => op.kind === first.kind);
  // "Changed status on 12 tasks" reads better than "12 changes".
  return uniform ? `${describe(first)} on ${taskCount} tasks` : `${ops.length} changes`;
}

function isSetField(op: Operation): op is SetFieldOp {
  return op.kind === "setField";
}

/** "status", "status and order", "status, order and name". */
function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * Drops operations that would change nothing.
 *
 * Clicking the status a task already has should not write a row, broadcast a
 * delta, or occupy a slot in the undo stack. Filtering here rather than at each
 * call site means no caller can forget.
 */
export function isNoop(op: Operation): boolean {
  if (op.kind === "setField" || op.kind === "setCustomField") {
    return sameValue(op.from, op.to);
  }
  // A document is a tree, so identity comparison would call every edit a
  // change — including the one where someone opened the box and closed it.
  if (op.kind === "editComment") {
    return renderPlain(op.from) === renderPlain(op.to);
  }
  if (op.kind === "setDescription") {
    return plainOrEmpty(op.from) === plainOrEmpty(op.to);
  }
  return false;
}

/** An absent description and an empty one are the same description. */
function plainOrEmpty(doc: RichDoc | null): string {
  return doc === null ? "" : renderPlain(doc).trim();
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a == null && b == null) return true;
  return false;
}

/**
 * A bounded stack of inverse batches, ready to apply.
 *
 * **It stores inverses, and `pop` returns them unchanged.** That is the whole
 * contract, and it is stated this loudly because getting it wrong is invisible:
 * the stack used to hold operations *as applied* and invert them on the way
 * out, while every server action already returns the inverse (D-036). The two
 * conventions composed into a double inversion, so undo re-applied the change
 * it was meant to reverse — the row did not move, and the toast still said it
 * had (D-049).
 *
 * The inversion belongs on the server because only the server knows the value a
 * field held before the write. A ten-minute-old tab does not. So the client's
 * job is to hold what it was handed and hand it back.
 *
 * Bounded deliberately: an unbounded stack in a long-lived tab is a memory leak,
 * and undo more than a few dozen steps back is not something anyone actually
 * wants — by then the correct tool is task history.
 */
export class UndoStack {
  private entries: Operation[][] = [];

  constructor(private readonly limit = 20) {}

  /** Records an inverse batch, exactly as the server returned it. */
  push(inverse: readonly Operation[]): void {
    const meaningful = inverse.filter((op) => !isNoop(op));
    if (meaningful.length === 0) return;

    this.entries.push(meaningful);
    if (this.entries.length > this.limit) this.entries.shift();
  }

  /**
   * The inverse batch to apply, unchanged, or undefined when nothing is left.
   *
   * Do not invert here. The batch is already an inverse.
   */
  pop(): Operation[] | undefined {
    return this.entries.pop();
  }

  peekDescription(): string | undefined {
    const last = this.entries.at(-1);
    return last ? describeBatch(last) : undefined;
  }

  get depth(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function humanize(field: TaskField): string {
  const labels: Record<TaskField, string> = {
    name: "name",
    statusId: "status",
    priority: "priority",
    dueAt: "due date",
    startAt: "start date",
    points: "points",
    timeEstimateMs: "estimate",
    parentTaskId: "parent",
    homeListId: "list",
    taskTypeId: "type",
    position: "order",
  };
  return labels[field];
}
