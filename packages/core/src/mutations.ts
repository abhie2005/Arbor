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

export type Operation =
  | SetFieldOp
  | SetCustomFieldOp
  | RelationOp
  | CreateTaskOp
  | ArchiveOp;

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
    default: {
      const exhaustive: never = op;
      throw new MutationError(`No description for: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function describeBatch(ops: readonly Operation[]): string {
  if (ops.length === 0) return "Nothing to undo";
  if (ops.length === 1) return describe(ops[0]!);

  const first = ops[0]!;
  const uniform = ops.every((op) => op.kind === first.kind);
  // "Changed status on 12 tasks" reads better than "12 changes".
  return uniform ? `${describe(first)} on ${ops.length} tasks` : `${ops.length} changes`;
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
  return false;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a == null && b == null) return true;
  return false;
}

/**
 * A bounded undo stack.
 *
 * Bounded deliberately: an unbounded stack in a long-lived tab is a memory leak,
 * and undo more than a few dozen steps back is not something anyone actually
 * wants — by then the correct tool is task history.
 */
export class UndoStack {
  private entries: Operation[][] = [];

  constructor(private readonly limit = 20) {}

  push(ops: readonly Operation[]): void {
    const meaningful = ops.filter((op) => !isNoop(op));
    if (meaningful.length === 0) return;

    this.entries.push(meaningful);
    if (this.entries.length > this.limit) this.entries.shift();
  }

  /** Returns the inverse batch to apply, or undefined when there's nothing left. */
  pop(): Operation[] | undefined {
    const last = this.entries.pop();
    return last ? invertBatch(last) : undefined;
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
