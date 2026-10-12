/**
 * Automations: a rule is a trigger, some conditions, and some actions.
 *
 * **The rule shape is the easy part**, as the schema note on `automations` has
 * said since Phase 1. The parts that are hard to take back are here, and each
 * one is a reuse rather than a new vocabulary:
 *
 * - **A trigger names its verb by calling the same function that writes it.**
 *   `activityVerb` turns an operation into `task.status_id_changed`; a trigger
 *   asking about a status change computes its verb by handing that function a
 *   synthetic operation. So a trigger and the log cannot disagree about what an
 *   event is called, and an operation that changes its verb drags every trigger
 *   along with it. The alternative — a second table of verb strings — is the
 *   bug where a rename makes every existing automation quietly stop firing.
 *
 * - **Conditions are a `FilterGroup`, and nothing here evaluates them.** A
 *   condition like "status is Done and priority is high" is a filter, the
 *   compiler already turns filters into SQL, and invariant 2 says a reader does
 *   not get a query of its own. An automation does not get a condition
 *   evaluator of its own either: the runtime asks the compiler whether this one
 *   task matches, which is how custom fields, nested AND/OR and every operator
 *   arrive for free and cannot drift from what a saved view means by the same
 *   words.
 *
 * - **An action compiles to an `Operation`** (D-125), because invariant 1 says
 *   `applyOperations` is the only thing that writes task data. The activity row
 *   comes free, and so does the answer to "whose undo stack does this land in":
 *   the stack lives in the browser and is filled by inverses handed back to the
 *   caller, so a robot's write lands in nobody's — by construction, not by a
 *   rule somebody has to remember.
 *
 * Everything in this file is pure. The runtime — claiming work, the service
 * account it acts as, the quota query — is in `packages/db`.
 */

import { type Operation, type TaskField, activityVerb } from "./mutations";
import { type RichDoc, parseRichText } from "./richtext";
import type { FilterGroup } from "./views/types";

export class AutomationError extends Error {}

/** Set membership, named the way `RelationOp` names it. */
export type RelationKind = "assignee" | "watcher" | "tag";

/**
 * What starts a rule.
 *
 * `to` and `from` are *optional narrowings*, and their absence is meaningful:
 * a `fieldChanged` trigger with no `to` fires on any change to that field,
 * which is why they are tested with `in` rather than against undefined. A rule
 * that fires only when a status becomes Done and one that fires whenever the
 * status moves are the same trigger kind with and without one key.
 */
export type AutomationTrigger =
  | { kind: "taskCreated" }
  | { kind: "taskArchived" }
  | { kind: "commentAdded" }
  | { kind: "fieldChanged"; field: TaskField; from?: unknown; to?: unknown }
  | { kind: "relationAdded"; relation: RelationKind; targetId?: string }
  | { kind: "relationRemoved"; relation: RelationKind; targetId?: string };

/**
 * What a rule does.
 *
 * Deliberately a subset of what an `Operation` can express. Every action here
 * is one a person could perform on the task the trigger fired for — an
 * automation that could create tasks anywhere, or edit somebody's comment,
 * would be a way to do things the permission check on the rule's container
 * never agreed to.
 */
export type AutomationAction =
  | { kind: "setField"; field: TaskField; to: unknown }
  | { kind: "addRelation"; relation: RelationKind; targetId: string }
  | { kind: "removeRelation"; relation: RelationKind; targetId: string }
  | { kind: "comment"; text: string }
  | { kind: "archive" };

export interface AutomationRule {
  trigger: AutomationTrigger;
  conditions: FilterGroup;
  actions: AutomationAction[];
  /** "tasks" | "subtasks" | "both", matching the column of the same name. */
  appliesTo: AppliesTo;
}

export type AppliesTo = "tasks" | "subtasks" | "both";

/**
 * One activity row, reduced to what a trigger may ask about.
 *
 * `field` is the **SQL column name** (`status_id`), not the operation's
 * (`statusId`) — the log stores the column and CLAUDE.md warns about exactly
 * this. Nothing here reads `field` directly for that reason: matching goes
 * through the verb, which already has the column name baked into it by the one
 * function that knows how to spell it.
 */
export interface AutomationEvent {
  activityId: string;
  verb: string;
  from: unknown;
  to: unknown;
  taskId: string;
  actorId: string;
  /** True when a task has a parent, for `appliesTo`. */
  isSubtask: boolean;
  /** The automation this event was itself produced by, when it was one. */
  causedBy?: { automationId: string; depth: number };
}

/**
 * The verb a trigger listens for, computed by the function that writes it.
 *
 * The synthetic operation is a throwaway whose only purpose is to be named —
 * ids are empty strings because `activityVerb` does not read them, and that is
 * a property worth relying on rather than working around, since the alternative
 * is spelling `task.status_id_changed` out a second time in this file.
 */
export function verbFor(trigger: AutomationTrigger): string {
  switch (trigger.kind) {
    case "taskCreated":
      return activityVerb({ kind: "createTask", taskId: "", listId: "", values: {} });

    case "taskArchived":
      return activityVerb({ kind: "archiveTask", taskId: "" });

    case "commentAdded":
      return activityVerb({
        kind: "createComment",
        commentId: "",
        taskId: "",
        body: EMPTY_DOC,
        parentId: null,
      });

    case "fieldChanged":
      return activityVerb({
        kind: "setField",
        taskId: "",
        field: trigger.field,
        from: null,
        to: null,
      });

    case "relationAdded":
      return activityVerb({
        kind: "addRelation",
        taskId: "",
        relation: trigger.relation,
        targetId: "",
      });

    case "relationRemoved":
      return activityVerb({
        kind: "removeRelation",
        taskId: "",
        relation: trigger.relation,
        targetId: "",
      });

    default: {
      const exhaustive: never = trigger;
      throw new AutomationError(`No verb for trigger: ${JSON.stringify(exhaustive)}`);
    }
  }
}

const EMPTY_DOC: RichDoc = { type: "doc", content: [] };

/**
 * Does this event start this rule?
 *
 * The verb first, then the narrowings. `appliesTo` is checked here rather than
 * by the caller because it is part of what the rule says it is about, and a
 * rule scoped to subtasks that fired on a parent would be wrong in a way that
 * no condition could express — `isSubtask` is a fact about the task's place in
 * the tree, not a filterable field.
 */
export function matches(rule: AutomationRule, event: AutomationEvent): boolean {
  if (verbFor(rule.trigger) !== event.verb) return false;
  if (!appliesToMatches(rule.appliesTo, event.isSubtask)) return false;

  const trigger = rule.trigger;

  if (trigger.kind === "fieldChanged") {
    if ("to" in trigger && !sameValue(trigger.to, event.to)) return false;
    if ("from" in trigger && !sameValue(trigger.from, event.from)) return false;
    return true;
  }

  // A relation's target is carried as the new value: `addRelation` logs the id
  // it added. An unnarrowed trigger fires for anybody.
  if (trigger.kind === "relationAdded" || trigger.kind === "relationRemoved") {
    if (trigger.targetId !== undefined && !sameValue(trigger.targetId, relationTarget(event))) {
      return false;
    }
    return true;
  }

  return true;
}

function appliesToMatches(appliesTo: AppliesTo, isSubtask: boolean): boolean {
  if (appliesTo === "both") return true;
  return appliesTo === "subtasks" ? isSubtask : !isSubtask;
}

/**
 * Which id a relation event was about.
 *
 * `addRelation` logs the target as the new value and `removeRelation` as the
 * old one, because that is what changed in each direction.
 */
function relationTarget(event: AutomationEvent): unknown {
  return event.to ?? event.from;
}

/**
 * Value equality across the JSON round trip.
 *
 * Activity values are `jsonb` and a trigger's narrowing came from a form, so
 * "3" and 3 are the same priority written by two honest paths. Comparing them
 * with `===` would make a rule that works in a test fail against the database
 * for reasons nobody can see on screen. Null and undefined are both "no value",
 * which is what a cleared field and an absent one both mean here.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
}

/**
 * The task as the actions need to see it.
 *
 * An `Operation` carries `from` as well as `to` so it can be inverted, which
 * means compiling an action requires knowing what the task holds now. That is
 * also what makes a no-op detectable before anything is written.
 */
export interface TaskSnapshot {
  id: string;
  name: string;
  statusId: string | null;
  priority: number | null;
  dueAt: string | null;
  startAt: string | null;
  points: number | null;
  timeEstimateMs: number | null;
  taskTypeId: string | null;
  parentTaskId: string | null;
  homeListId: string;
  assignees: readonly string[];
  watchers: readonly string[];
  tags: readonly string[];
}

const SNAPSHOT_FIELDS: Record<string, keyof TaskSnapshot> = {
  name: "name",
  statusId: "statusId",
  priority: "priority",
  dueAt: "dueAt",
  startAt: "startAt",
  points: "points",
  timeEstimateMs: "timeEstimateMs",
  taskTypeId: "taskTypeId",
  parentTaskId: "parentTaskId",
  homeListId: "homeListId",
};

/**
 * Actions to operations, against the task as it stands.
 *
 * **No-ops are dropped here as well as in `applyOperations`.** The executor
 * already filters them, so this is not needed for correctness — it is needed
 * for the run record: a rule that fires a hundred times and changes nothing
 * should say it changed nothing, and a run that reports three applied
 * operations when the task was already in that state is a log that lies
 * quietly.
 *
 * `newId` is a parameter because a comment needs a uuid and a pure function may
 * not invent one. The caller passes `randomUUID`; a test passes a counter.
 */
export function compileActions(
  actions: readonly AutomationAction[],
  task: TaskSnapshot,
  newId: () => string,
): Operation[] {
  const ops: Operation[] = [];

  for (const action of actions) {
    switch (action.kind) {
      case "setField": {
        const key = SNAPSHOT_FIELDS[action.field];
        if (!key) throw new AutomationError(`An automation cannot set ${action.field}`);

        const from = task[key] ?? null;
        if (sameValue(from, action.to)) break;

        ops.push({ kind: "setField", taskId: task.id, field: action.field, from, to: action.to });
        break;
      }

      case "addRelation": {
        if (currentRelation(task, action.relation).includes(action.targetId)) break;
        ops.push({
          kind: "addRelation",
          taskId: task.id,
          relation: action.relation,
          targetId: action.targetId,
        });
        break;
      }

      case "removeRelation": {
        if (!currentRelation(task, action.relation).includes(action.targetId)) break;
        ops.push({
          kind: "removeRelation",
          taskId: task.id,
          relation: action.relation,
          targetId: action.targetId,
        });
        break;
      }

      // No mention resolution: the text is a rule written once, not a message
      // somebody is typing, and resolving "@Name" here would need the member
      // list and would silently bind a rule to whoever held that name the day
      // it was saved. Writing a mention deliberately is D-122's job.
      case "comment":
        ops.push({
          kind: "createComment",
          commentId: newId(),
          taskId: task.id,
          body: parseRichText(action.text, []),
          parentId: null,
        });
        break;

      case "archive":
        ops.push({ kind: "archiveTask", taskId: task.id });
        break;

      default: {
        const exhaustive: never = action;
        throw new AutomationError(`Unknown action: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return ops;
}

function currentRelation(task: TaskSnapshot, relation: RelationKind): readonly string[] {
  if (relation === "assignee") return task.assignees;
  if (relation === "watcher") return task.watchers;
  return task.tags;
}

/**
 * How far a cascade may go before it is refused.
 *
 * Three, because the loops worth allowing are short — a rule that moves a task
 * and a second that comments on the move — and the ones worth refusing are not
 * loops anybody designed. The number is small on purpose: a deep cascade is
 * indistinguishable from a cycle to everyone except the person who wrote it.
 */
export const MAX_DEPTH = 3;

export type RunVerdict = "run" | "skipped_self" | "refused_depth" | "refused_quota";

/**
 * Whether this run may proceed, and if not, which refusal to record.
 *
 * **A rule never answers itself.** `A fires A` is the one cycle that needs no
 * depth counter to recognise, and refusing it by depth would still let it run
 * three times first. Recorded as `skipped_self` rather than as a refusal,
 * because nothing was wrong — the rule simply has nothing to say about its own
 * output.
 *
 * Both other verdicts are statuses the schema already declared, which is what
 * makes a refusal a row rather than a silence: a quota that stops an
 * automation without saying so is indistinguishable from a broken rule.
 */
export function runVerdict(input: {
  automationId: string;
  event: AutomationEvent;
  runsThisPeriod: number;
  quota: number;
  maxDepth?: number;
}): RunVerdict {
  const { automationId, event, runsThisPeriod, quota } = input;
  const maxDepth = input.maxDepth ?? MAX_DEPTH;

  if (event.causedBy?.automationId === automationId) return "skipped_self";
  if (depthOf(event) > maxDepth) return "refused_depth";
  if (runsThisPeriod >= quota) return "refused_quota";
  return "run";
}

/** The depth a run triggered by this event would have. */
export function depthOf(event: AutomationEvent): number {
  return (event.causedBy?.depth ?? -1) + 1;
}

/**
 * The key that makes re-reading the log harmless.
 *
 * The runtime scans activity with an overlap rather than a perfect watermark,
 * because activity ids come from a sequence and a lower id can commit after a
 * higher one — a strict "last id seen" silently skips whatever was still in
 * flight. Overlapping and letting the unique index refuse the duplicate is the
 * trade the schema already chose by putting a unique index on this column.
 */
export function idempotencyKeyFor(automationId: string, activityId: string): string {
  return `${automationId}:${activityId}`;
}

/**
 * Validates a stored rule, or says why it cannot be one.
 *
 * Called before a rule is written, the way a view definition is compiled before
 * it is saved: a rule that cannot run is caught by the person writing it, not
 * at three in the morning by a queue that records `failed` forever.
 */
export function parseAutomationRule(raw: unknown): AutomationRule {
  if (!raw || typeof raw !== "object") throw new AutomationError("An automation needs a rule");

  const value = raw as Record<string, unknown>;
  const trigger = parseTrigger(value.trigger);
  const actions = parseActions(value.actions);
  const appliesTo = parseAppliesTo(value.appliesTo);

  const conditions = (value.conditions ?? { op: "AND", conditions: [] }) as FilterGroup;
  if (typeof conditions !== "object" || !Array.isArray(conditions.conditions)) {
    throw new AutomationError("Conditions must be a filter group");
  }

  return { trigger, conditions, actions, appliesTo };
}

const TRIGGER_KINDS = [
  "taskCreated",
  "taskArchived",
  "commentAdded",
  "fieldChanged",
  "relationAdded",
  "relationRemoved",
] as const;

const RELATIONS: readonly RelationKind[] = ["assignee", "watcher", "tag"];

function parseTrigger(raw: unknown): AutomationTrigger {
  if (!raw || typeof raw !== "object") throw new AutomationError("An automation needs a trigger");
  const value = raw as Record<string, unknown>;
  const kind = value.kind;

  if (typeof kind !== "string" || !TRIGGER_KINDS.includes(kind as never)) {
    throw new AutomationError(`Not a trigger: ${String(kind)}`);
  }

  if (kind === "fieldChanged") {
    const field = value.field;
    if (typeof field !== "string" || !(field in SNAPSHOT_FIELDS)) {
      throw new AutomationError(`An automation cannot watch ${String(field)}`);
    }
    const trigger: Extract<AutomationTrigger, { kind: "fieldChanged" }> = {
      kind,
      field: field as TaskField,
    };
    if ("to" in value) trigger.to = value.to;
    if ("from" in value) trigger.from = value.from;
    return trigger;
  }

  if (kind === "relationAdded" || kind === "relationRemoved") {
    const relation = value.relation;
    if (typeof relation !== "string" || !RELATIONS.includes(relation as RelationKind)) {
      throw new AutomationError(`Not a relation: ${String(relation)}`);
    }
    const trigger: Extract<AutomationTrigger, { kind: "relationAdded" | "relationRemoved" }> = {
      kind,
      relation: relation as RelationKind,
    };
    if (typeof value.targetId === "string") trigger.targetId = value.targetId;
    return trigger;
  }

  return { kind } as AutomationTrigger;
}

function parseActions(raw: unknown): AutomationAction[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AutomationError("An automation needs at least one action");
  }

  return raw.map((entry) => {
    if (!entry || typeof entry !== "object") throw new AutomationError("Not an action");
    const value = entry as Record<string, unknown>;

    switch (value.kind) {
      case "setField": {
        const field = value.field;
        if (typeof field !== "string" || !(field in SNAPSHOT_FIELDS)) {
          throw new AutomationError(`An automation cannot set ${String(field)}`);
        }
        return { kind: "setField", field: field as TaskField, to: value.to ?? null };
      }

      case "addRelation":
      case "removeRelation": {
        const relation = value.relation;
        const targetId = value.targetId;
        if (typeof relation !== "string" || !RELATIONS.includes(relation as RelationKind)) {
          throw new AutomationError(`Not a relation: ${String(relation)}`);
        }
        if (typeof targetId !== "string" || targetId === "") {
          throw new AutomationError("A relation action needs somebody to act on");
        }
        return { kind: value.kind, relation: relation as RelationKind, targetId };
      }

      case "comment": {
        const text = value.text;
        if (typeof text !== "string" || text.trim() === "") {
          throw new AutomationError("A comment action needs something to say");
        }
        return { kind: "comment", text: text.trim() };
      }

      case "archive":
        return { kind: "archive" };

      default:
        throw new AutomationError(`Not an action: ${String(value.kind)}`);
    }
  });
}

function parseAppliesTo(raw: unknown): AppliesTo {
  if (raw === undefined || raw === null) return "tasks";
  if (raw === "tasks" || raw === "subtasks" || raw === "both") return raw;
  throw new AutomationError(`Not a scope: ${String(raw)}`);
}
