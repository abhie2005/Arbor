/**
 * Status sets: resolution, templates, and safe deletion.
 *
 * A status is the most visible thing a team configures and the most dangerous
 * thing to get wrong, because every task points at one. Three rules live here:
 *
 * 1. **A list's set is inherited**, resolved through the same walk as every
 *    other piece of container configuration (`resolveInherited`). One walk,
 *    one answer, and the UI can say "inherited from Engineering" because the
 *    resolution reports where it stopped.
 * 2. **A set must stay usable.** Not every arrangement of statuses is a valid
 *    workflow, and the invalid ones break reporting rather than the editor.
 * 3. **Deleting a status is a task migration**, expressed as ordinary
 *    invertible operations — so it lands in the activity log and undo works on
 *    it, like every other change.
 */

import {
  type ContainerNode,
  HierarchyError,
  resolveInherited,
} from "./hierarchy";
import type { Operation } from "./mutations";

export type StatusGroup = "not_started" | "active" | "done" | "closed";

export const STATUS_GROUPS = ["not_started", "active", "done", "closed"] as const;

/** Groups that mean "this task is still work". The complement is terminal. */
export const OPEN_GROUPS: readonly StatusGroup[] = ["not_started", "active"];

export interface StatusDefinition {
  id: string;
  name: string;
  group: StatusGroup;
  color: string;
  position: number;
}

export interface StatusSetDefinition {
  id: string;
  name: string;
  /** Null for a workspace-level default or an unattached template. */
  containerId: string | null;
  isTemplate: boolean;
  statuses: StatusDefinition[];
}

export class StatusError extends Error {}

export function isStatusGroup(value: unknown): value is StatusGroup {
  return typeof value === "string" && (STATUS_GROUPS as readonly string[]).includes(value);
}

/**
 * The set a container's tasks use: its own, else its nearest ancestor's, else
 * the workspace default.
 *
 * `source` is not decoration. A settings screen that cannot say where a value
 * came from leaves the user guessing why editing a list changed a folder, and
 * that is how someone edits a shared set thinking it is local.
 */
export function resolveStatusSet(
  containerId: string,
  containers: ReadonlyMap<string, ContainerNode>,
  setsByContainer: ReadonlyMap<string, StatusSetDefinition>,
  workspaceDefault?: StatusSetDefinition,
): { set: StatusSetDefinition; source: ContainerNode | "workspace" } {
  const inherited = resolveInherited(containerId, containers, (node) =>
    setsByContainer.get(node.id),
  );

  if (inherited) return { set: inherited.value, source: inherited.source };
  if (workspaceDefault) return { set: workspaceDefault, source: "workspace" };

  throw new StatusError(
    `No status set resolves for container ${containerId}, and the workspace has no default`,
  );
}

/**
 * Whether a set can actually run a workflow.
 *
 * **Why this is enforced and not merely encouraged.** Every arrangement below
 * type-checks and every one of them breaks something a user would call a bug:
 *
 * - No terminal status → nothing can ever be finished, "hide closed" hides
 *   nothing, and completion percentage is always zero.
 * - No open status → every task in the set is born complete.
 * - Two statuses with the same name → the filter menu shows two identical
 *   entries and picking either is a coin flip.
 *
 * Statuses that are merely *unusual* — six active columns, no `done` but a
 * `closed` — are allowed. The line is drawn at arrangements that make a
 * question unanswerable, not at ones that look unfamiliar.
 */
export function assertUsableStatusSet(statuses: readonly StatusDefinition[]): void {
  if (statuses.length === 0) {
    throw new StatusError("A status set needs at least one status");
  }

  const open = statuses.filter((s) => OPEN_GROUPS.includes(s.group));
  const terminal = statuses.filter((s) => !OPEN_GROUPS.includes(s.group));

  if (open.length === 0) {
    throw new StatusError(
      "A status set needs at least one open status — every task would otherwise start finished",
    );
  }
  if (terminal.length === 0) {
    throw new StatusError(
      "A status set needs at least one done or closed status — nothing could ever be completed",
    );
  }

  const seen = new Set<string>();
  for (const status of statuses) {
    const key = status.name.trim().toLowerCase();
    if (!key) throw new StatusError("A status needs a name");
    if (seen.has(key)) throw new StatusError(`Duplicate status name: ${status.name}`);
    seen.add(key);
  }
}

/**
 * Whether a status can be removed without a migration target.
 *
 * Separate from `assertUsableStatusSet` because the answer differs: a set with
 * one `done` status is fine, but deleting that status is not.
 */
export function canDeleteStatus(
  statuses: readonly StatusDefinition[],
  statusId: string,
): { ok: true } | { ok: false; reason: string } {
  const remaining = statuses.filter((s) => s.id !== statusId);

  if (remaining.length === statuses.length) {
    return { ok: false, reason: "That status is not in this set" };
  }

  try {
    assertUsableStatusSet(remaining);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface StatusDeletionPlan {
  /** Tasks to move, as invertible operations. Empty when nothing used it. */
  operations: Operation[];
  movedTasks: number;
  replacementId: string;
}

/**
 * What deleting a status does to the tasks still using it.
 *
 * Returned as `Operation[]` rather than executed as a bulk `UPDATE` so the
 * migration is undoable and each task's move appears in its own history. A
 * user who deletes the wrong status gets ⌘Z; with a bulk update they get a
 * support ticket.
 *
 * The replacement is required, never defaulted. Guessing "the first status in
 * the same group" silently reopens finished work when the deleted status was
 * the only `done` one — and a wrong guess here is invisible until a report is
 * already wrong.
 */
export function planStatusDeletion(
  statuses: readonly StatusDefinition[],
  statusId: string,
  replacementId: string,
  taskIds: readonly string[],
): StatusDeletionPlan {
  const doomed = statuses.find((s) => s.id === statusId);
  if (!doomed) throw new StatusError(`Status ${statusId} is not in this set`);

  if (replacementId === statusId) {
    throw new StatusError("A status cannot be replaced by itself");
  }

  const replacement = statuses.find((s) => s.id === replacementId);
  if (!replacement) {
    throw new StatusError(
      `Replacement status ${replacementId} is not in the same set — tasks must land somewhere their list can display`,
    );
  }

  const verdict = canDeleteStatus(statuses, statusId);
  if (!verdict.ok) throw new StatusError(verdict.reason);

  return {
    operations: taskIds.map((taskId) => ({
      kind: "setField",
      taskId,
      field: "statusId",
      from: statusId,
      to: replacementId,
    })),
    movedTasks: taskIds.length,
    replacementId,
  };
}

/**
 * Positions after moving one status to a new index.
 *
 * Integers, not the fractional indices tasks use (D-012). A set holds a handful
 * of statuses reordered by one person in a settings dialog — there is no
 * concurrent-drag problem to solve, and integers keep `ORDER BY position`
 * readable in a psql session.
 */
export function reorderStatuses(
  statuses: readonly StatusDefinition[],
  statusId: string,
  toIndex: number,
): StatusDefinition[] {
  const ordered = [...statuses].sort((a, b) => a.position - b.position);
  const from = ordered.findIndex((s) => s.id === statusId);

  if (from === -1) throw new StatusError(`Status ${statusId} is not in this set`);
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= ordered.length) {
    throw new StatusError(`Cannot move a status to index ${toIndex}`);
  }

  const [moved] = ordered.splice(from, 1);
  if (!moved) throw new StatusError("Status disappeared while reordering");
  ordered.splice(toIndex, 0, moved);

  return ordered.map((status, index) => ({ ...status, position: index }));
}

export interface StatusTemplate {
  key: string;
  name: string;
  description: string;
  statuses: Omit<StatusDefinition, "id">[];
}

/**
 * Starting points, not constraints.
 *
 * Templates exist because the blank state of a status editor is a bad place to
 * learn what `not_started` versus `active` means. Every one of these is
 * editable the moment it is applied — they seed a set, they do not define a
 * type of set.
 */
export const STATUS_TEMPLATES: readonly StatusTemplate[] = [
  {
    key: "simple",
    name: "Simple",
    description: "Three columns. The right answer more often than teams expect.",
    statuses: [
      { name: "To Do", group: "not_started", color: "#6B7686", position: 0 },
      { name: "In Progress", group: "active", color: "#5B8DEF", position: 1 },
      { name: "Done", group: "done", color: "#43B581", position: 2 },
    ],
  },
  {
    key: "scrum",
    name: "Scrum",
    description: "Backlog through review, with a separate closed state for the sprint.",
    statuses: [
      { name: "Backlog", group: "not_started", color: "#6B7686", position: 0 },
      { name: "Ready", group: "not_started", color: "#8A94A6", position: 1 },
      { name: "In Progress", group: "active", color: "#5B8DEF", position: 2 },
      { name: "In Review", group: "active", color: "#C77DD8", position: 3 },
      { name: "Done", group: "done", color: "#43B581", position: 4 },
      { name: "Closed", group: "closed", color: "#4A5563", position: 5 },
    ],
  },
  {
    key: "kanban",
    name: "Kanban",
    description: "Flow with an explicit blocked state, which is the point of the board.",
    statuses: [
      { name: "Backlog", group: "not_started", color: "#6B7686", position: 0 },
      { name: "In Progress", group: "active", color: "#5B8DEF", position: 1 },
      // Blocked is `active`, not a group of its own: the work is still in
      // flight, and a fifth group would break cross-workspace reporting (D-014).
      { name: "Blocked", group: "active", color: "#EC5B5B", position: 2 },
      { name: "Shipped", group: "done", color: "#43B581", position: 3 },
    ],
  },
  {
    key: "marketing",
    name: "Marketing",
    description: "A review-heavy pipeline, where most of the time is spent waiting.",
    statuses: [
      { name: "Idea", group: "not_started", color: "#6B7686", position: 0 },
      { name: "Drafting", group: "active", color: "#5B8DEF", position: 1 },
      { name: "In Review", group: "active", color: "#C77DD8", position: 2 },
      { name: "Scheduled", group: "active", color: "#E9A23B", position: 3 },
      { name: "Published", group: "done", color: "#43B581", position: 4 },
    ],
  },
];

export function statusTemplate(key: string): StatusTemplate {
  const template = STATUS_TEMPLATES.find((t) => t.key === key);
  if (!template) throw new StatusError(`Unknown status template: ${key}`);
  return template;
}

/**
 * Which containers stop inheriting if a set is attached here.
 *
 * A settings screen has to be able to say "this will change 4 lists" before the
 * user commits, and the only way to know is to walk down and see which
 * descendants have no set of their own.
 */
export function containersAffectedBy(
  containerId: string,
  containers: ReadonlyMap<string, ContainerNode>,
  setsByContainer: ReadonlyMap<string, StatusSetDefinition>,
): string[] {
  const node = containers.get(containerId);
  if (!node) throw new HierarchyError(`Container not found: ${containerId}`);

  const childrenByParent = new Map<string, ContainerNode[]>();
  for (const candidate of containers.values()) {
    if (!candidate.parentId) continue;
    const siblings = childrenByParent.get(candidate.parentId) ?? [];
    siblings.push(candidate);
    childrenByParent.set(candidate.parentId, siblings);
  }

  const affected: string[] = [containerId];
  const stack = [...(childrenByParent.get(containerId) ?? [])];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    // A descendant with its own set overrides this one, and so does everything
    // beneath it — stop descending rather than reporting a change that is not
    // going to happen.
    if (setsByContainer.has(current.id)) continue;

    affected.push(current.id);
    stack.push(...(childrenByParent.get(current.id) ?? []));
  }

  return affected;
}
