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

import { addUtcDays, startOfUtcDay } from "./dates";
import { type Operation, type TaskField, activityVerb } from "./mutations";
import { type RichDoc, parseRichText } from "./richtext";
import type { ValueInput } from "./views/filterable";
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

/**
 * A date an action works out when it runs, rather than one somebody typed.
 *
 * "Set the due date to three days from now" cannot be stored as a value,
 * because the value does not exist until the rule acts — and a rule is written
 * once and then runs for a year, so the date the form happened to be open on is
 * the one answer that is certainly wrong. The action stores the *arithmetic*
 * and `compileActions` does it.
 *
 * **The anchor is a choice, and both answers are real rules.** `now` is "three
 * days from when this runs", which is what a rule on task creation wants.
 * `current` is "three days later than it already is", which is what a rule that
 * pushes a blocked task out wants — and that one has nothing to count from when
 * the field is empty, so it writes nothing rather than inventing a date from
 * today. `compileActions` is where that is enforced.
 *
 * **It is not a delay.** `delaySeconds` is how long a rule waits before acting;
 * this is what it writes once it does. A rule may carry both, and then the days
 * are counted from the moment it acts rather than from the moment it fired —
 * because that is when `compileActions` runs. Those are different dates for any
 * rule that waits, and the acting one is the one somebody means.
 */
export interface RelativeDate {
  kind: "relativeDate";
  /** Whole days from the anchor. Negative is before it. */
  days: number;
  /** The moment the rule acts, or the value the field already holds. */
  from: "now" | "current";
}

/**
 * Ten years, which matches nothing in particular — a ceiling rather than a
 * rule, the way `MAX_DELAY_SECONDS` is. What it refuses is a typo with six
 * digits in it, which would otherwise be stored and then compile to a date
 * outside what the column can hold.
 */
export const MAX_RELATIVE_DAYS = 3650;

/**
 * Is this value a relative date?
 *
 * A tag check rather than a validation: everything stored went through
 * `parseActions`, which is where the days and the anchor are checked, so
 * checking them again on every read would be two places to keep in step. A
 * value that reached the column some other way is the same problem as a trigger
 * the parser can no longer read, and it has the same answer (D-140).
 */
export function isRelativeDate(value: unknown): value is RelativeDate {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "relativeDate"
  );
}

/**
 * Does this field hold a date?
 *
 * Read off `AUTOMATABLE_FIELDS` rather than listed a second time here, so the
 * fields a relative date may be set on are exactly the ones the menu offers a
 * date control for. The same bet as D-146: one declaration, or two that drift.
 */
export function isDateField(field: TaskField): boolean {
  return AUTOMATABLE_FIELDS.some(
    (candidate) => candidate.field === field && candidate.input === "date",
  );
}

export interface AutomationRule {
  trigger: AutomationTrigger;
  conditions: FilterGroup;
  actions: AutomationAction[];
  /** "tasks" | "subtasks" | "both", matching the column of the same name. */
  appliesTo: AppliesTo;
  /**
   * How long to wait before acting, in seconds. Zero is immediately (D-128).
   *
   * **The delay is the rule's, not the trigger's.** What fires a rule and how
   * long it then waits are different questions, and conflating them would put a
   * duration inside the object that gets matched against an activity row.
   */
  delaySeconds: number;
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
 * What a `setField` action writes, or that it writes nothing.
 *
 * Two shapes rather than a value and a null, because **null is a value here**:
 * "clear the due date" is a real action, and a function that returned null for
 * both that and "there was nothing to write" would make the two
 * indistinguishable at the only place that can tell them apart.
 */
type Resolved = { write: true; value: unknown } | { write: false };

/**
 * A date is worked out; everything else is copied.
 *
 * Two things happen here and both are about invariant 9 — a calendar day is
 * midnight UTC and is read in UTC:
 *
 * - **a relative date becomes an instant**, counted in UTC days from its
 *   anchor. An empty anchor writes nothing: "three days later than it is" has
 *   no answer for a task with no due date, and the alternative — falling back
 *   to today — is a rule inventing a deadline nobody wrote;
 * - **a `YYYY-MM-DD` typed into the form becomes midnight UTC** rather than
 *   reaching the column as ten characters for Postgres to interpret in whatever
 *   zone the server happens to be set to. It also makes the no-op check work at
 *   all: `from` is an ISO instant, so comparing it against "2026-11-20" said
 *   "different" every time and a rule that set the date it was already set to
 *   logged a change.
 *
 * An ISO instant arriving through the API is left exactly as it came — that is
 * a moment rather than a day, and the one thing this must not do is round it.
 */
function resolveValue(field: TaskField, to: unknown, current: unknown, now: Date): Resolved {
  if (isRelativeDate(to)) {
    if (!isDateField(field)) {
      throw new AutomationError(`A relative date cannot be set on ${field}`);
    }

    const anchor = to.from === "now" ? now : current;
    if (anchor === null || anchor === undefined || anchor === "") return { write: false };

    return { write: true, value: addUtcDays(anchor as string | Date, to.days).toISOString() };
  }

  if (isDateField(field) && typeof to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { write: true, value: startOfUtcDay(to).toISOString() };
  }

  return { write: true, value: to };
}

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
 * **`now` is a parameter for exactly the same reason** — a relative date is
 * arithmetic on the clock, and reading the clock is as much an effect as
 * inventing an id. The runtime passes `new Date()` at the moment it acts; a
 * test passes a fixed instant and gets an answer it can write down.
 */
export function compileActions(
  actions: readonly AutomationAction[],
  task: TaskSnapshot,
  newId: () => string,
  now: Date,
): Operation[] {
  const ops: Operation[] = [];

  for (const action of actions) {
    switch (action.kind) {
      case "setField": {
        const key = SNAPSHOT_FIELDS[action.field];
        if (!key) throw new AutomationError(`An automation cannot set ${action.field}`);

        const from = task[key] ?? null;
        const resolved = resolveValue(action.field, action.to, from, now);
        if (!resolved.write) break;
        if (sameValue(from, resolved.value)) break;

        ops.push({
          kind: "setField",
          taskId: task.id,
          field: action.field,
          from,
          to: resolved.value,
        });
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
 * The longest a rule may wait.
 *
 * Thirty days, because a delay is a promise the system has to keep: a run
 * queued for next year is a row that has to survive every migration and every
 * change to what an action means between now and then. A month is long enough
 * for "chase this if it is still open" and short enough that a pending row is
 * never archaeology.
 */
export const MAX_DELAY_SECONDS = 30 * 24 * 60 * 60;

/**
 * How far a cascade may go before it is refused.
 *
 * Three, because the loops worth allowing are short — a rule that moves a task
 * and a second that comments on the move — and the ones worth refusing are not
 * loops anybody designed. The number is small on purpose: a deep cascade is
 * indistinguishable from a cycle to everyone except the person who wrote it.
 */
export const MAX_DEPTH = 3;

/**
 * How many times a run may be attempted before it is left alone.
 *
 * Three, and the reasoning is what it is *not* for. A rule whose actions are
 * wrong fails identically every time — a retry cannot fix an action the parser
 * accepted and the executor refuses — so this exists for the failures that are
 * about the *moment*: a deadlock with a concurrent write, a connection dropped
 * mid-commit, a snapshot read while somebody was deleting the task. Those clear
 * on their own; a bad rule does not. Three is enough for the first kind and few
 * enough that the second kind stops being retried before anybody notices it was
 * being retried at all.
 */
export const MAX_RUN_ATTEMPTS = 3;

/**
 * When to try a failed run again, or `null` to stop trying.
 *
 * **`attempts` is the number already made**, which the claim increments before
 * the attempt happens, so the first failure arrives here as 1. Backoff is 30s
 * then 120s and then nothing — geometric rather than constant because the
 * failures worth retrying are contention, and retrying contention immediately
 * is how one failure becomes a queue of them.
 *
 * In core rather than as an interval inside the claim's SQL because it is the
 * part somebody will want to argue about, and an argument belongs where it can
 * be checked without a database — the D-139 pattern, where the guards are the
 * decision so they live somewhere testable.
 */
export function retryAfterSeconds(
  attempts: number,
  maxAttempts: number = MAX_RUN_ATTEMPTS,
): number | null {
  if (attempts < 1) return null;
  if (attempts >= maxAttempts) return null;
  return 30 * 4 ** (attempts - 1);
}

/** Whether a failed run has an attempt left in it. */
export function mayRetry(attempts: number, maxAttempts: number = MAX_RUN_ATTEMPTS): boolean {
  return retryAfterSeconds(attempts, maxAttempts) !== null;
}

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

  return { trigger, conditions, actions, appliesTo, delaySeconds: parseDelay(value.delaySeconds) };
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
        return {
          kind: "setField",
          field: field as TaskField,
          to: parseActionValue(field as TaskField, value.to ?? null),
        };
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

/**
 * The value half of a `setField` action.
 *
 * **A scalar passes through untouched**, which is deliberate rather than lazy:
 * the column decides what it accepts, the executor refuses what it cannot write
 * and D-134 already drew that table. Validating types a second time here would
 * be a second opinion about what a column holds.
 *
 * **The only structure a value may have is a relative date.** Before this,
 * `to` was taken as it arrived, so an object posted where a status goes was
 * stored, armed, and then handed to a uuid column — a caller-triggerable 500 at
 * 3am rather than a 400 at the door, which is the same thing `parseOperations`
 * exists to stop. So anything else object-shaped is refused by name, and a
 * relative date is checked properly: the days are whole and bounded, and the
 * anchor is one of the two the compiler knows how to count from.
 *
 * It is also refused on a field that does not hold a date, where it would
 * otherwise parse, store, arm, and then throw inside the run.
 */
function parseActionValue(field: TaskField, raw: unknown): unknown {
  if (raw === null || typeof raw !== "object") return raw;

  const value = raw as Record<string, unknown>;
  if (value.kind !== "relativeDate") {
    throw new AutomationError(`Not a value for ${field}: ${JSON.stringify(raw)}`);
  }
  if (!isDateField(field)) {
    throw new AutomationError(`A relative date cannot be set on ${field}`);
  }

  const days = value.days;
  if (typeof days !== "number" || !Number.isInteger(days)) {
    throw new AutomationError("A relative date is a whole number of days");
  }
  if (Math.abs(days) > MAX_RELATIVE_DAYS) {
    throw new AutomationError(`A relative date may be at most ${MAX_RELATIVE_DAYS} days away`);
  }

  // `now` by default, because that is the anchor somebody who wrote only the
  // days meant — and because a missing anchor is the one case where guessing is
  // safe: the other answer needs a value the task may not have.
  const from = value.from ?? "now";
  if (from !== "now" && from !== "current") {
    throw new AutomationError(`A relative date counts from now or from current, not ${String(from)}`);
  }

  return { kind: "relativeDate", days, from } satisfies RelativeDate;
}

/**
 * A delay, in whole seconds.
 *
 * Rejecting a fractional or negative delay rather than clamping it: a rule
 * saved with `-1` meant something, and quietly storing `0` turns "act an hour
 * before" — which this cannot express — into "act immediately", which is a
 * different rule running in production than the one somebody wrote.
 */
function parseDelay(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new AutomationError("A delay is a whole number of seconds");
  }
  if (raw < 0) throw new AutomationError("A delay cannot be negative");
  if (raw > MAX_DELAY_SECONDS) {
    throw new AutomationError(`A delay may be at most ${MAX_DELAY_SECONDS} seconds`);
  }
  return raw;
}

function parseAppliesTo(raw: unknown): AppliesTo {
  if (raw === undefined || raw === null) return "tasks";
  if (raw === "tasks" || raw === "subtasks" || raw === "both") return raw;
  throw new AutomationError(`Not a scope: ${String(raw)}`);
}

/**
 * What an automation form may offer.
 *
 * **The same bet `filterable.ts` makes, for the other half of a rule.**
 * `parseAutomationRule` already refuses a trigger on a field no operation can
 * set, and `verbFor` already refuses a trigger nothing emits — but refusing is
 * the last line, not the interface. A menu offering an option the server will
 * reject has already failed whoever used it.
 *
 * So the knowledge that powers those refusals is published here, and the
 * control each value needs is named with `ValueInput` — the filter bar's own
 * vocabulary — so a status is a status menu in a condition and in an action,
 * from one declaration rather than two that drift.
 */

/** A field a rule may watch or write, and the control its value needs. */
export interface AutomatableField {
  /** The operation's name (`statusId`), which is what a rule stores. */
  field: TaskField;
  label: string;
  input: ValueInput;
}

/**
 * The fields a form offers, which is deliberately narrower than what a rule
 * may contain.
 *
 * `parentTaskId` is absent, and `position` with it. Both are settable by an
 * operation and both parse, so a rule written against the API keeps working —
 * the omission is this menu's, not the rule language's, exactly as `position`
 * is absent from `BUILTIN_FILTERABLE`. The reason is that neither has a control
 * to offer: "parent task" needs a task picker nobody has built, and a uuid in a
 * text box is not an interface, it is a way to store a typo.
 *
 * `timeEstimateMs` no longer says "(ms)" in its label, because the box no
 * longer wants milliseconds: `duration` is a `ValueInput` now and the filter
 * bar learned it in the same change, which is what that job always was
 * (D-148).
 */
export const AUTOMATABLE_FIELDS: readonly AutomatableField[] = [
  { field: "name", label: "Name", input: "text" },
  { field: "statusId", label: "Status", input: "status" },
  { field: "priority", label: "Priority", input: "priority" },
  { field: "dueAt", label: "Due date", input: "date" },
  { field: "startAt", label: "Start date", input: "date" },
  { field: "points", label: "Points", input: "number" },
  { field: "timeEstimateMs", label: "Estimate", input: "duration" },
  { field: "taskTypeId", label: "Task type", input: "taskType" },
  // `list` rather than a generic container (D-146): this action moves a task to
  // a list, and a menu that offered a space would compile to an operation the
  // executor refuses.
  { field: "homeListId", label: "List", input: "list" },
];

/** The control a relation's target needs: a person for two of them, a tag for one. */
export function relationInput(relation: RelationKind): ValueInput {
  return relation === "tag" ? "tag" : "user";
}

export const RELATION_LABELS: Record<RelationKind, string> = {
  assignee: "Assignee",
  watcher: "Watcher",
  tag: "Tag",
};

/**
 * What else a form must ask for once a kind is chosen.
 *
 * Three answers rather than a boolean, because the follow-up question differs:
 * a field trigger needs a field *and then* the control that field implies,
 * while a relation trigger needs a relation and then a person or a tag.
 */
export type AutomationNeeds = "none" | "field" | "relation" | "text";

export interface AutomationTriggerOption {
  kind: AutomationTrigger["kind"];
  label: string;
  needs: AutomationNeeds;
}

export const AUTOMATION_TRIGGERS: readonly AutomationTriggerOption[] = [
  { kind: "fieldChanged", label: "A field changes", needs: "field" },
  { kind: "taskCreated", label: "A task is created", needs: "none" },
  { kind: "taskArchived", label: "A task is archived", needs: "none" },
  { kind: "commentAdded", label: "A comment is added", needs: "none" },
  { kind: "relationAdded", label: "Somebody or something is added", needs: "relation" },
  { kind: "relationRemoved", label: "Somebody or something is removed", needs: "relation" },
];

export interface AutomationActionOption {
  kind: AutomationAction["kind"];
  label: string;
  needs: AutomationNeeds;
}

export const AUTOMATION_ACTIONS: readonly AutomationActionOption[] = [
  { kind: "setField", label: "Set a field", needs: "field" },
  { kind: "addRelation", label: "Add", needs: "relation" },
  { kind: "removeRelation", label: "Remove", needs: "relation" },
  { kind: "comment", label: "Comment", needs: "text" },
  { kind: "archive", label: "Archive the task", needs: "none" },
];

export const APPLIES_TO_LABELS: Record<AppliesTo, string> = {
  tasks: "Tasks only",
  subtasks: "Subtasks only",
  both: "Tasks and subtasks",
};

/**
 * The delays a form offers, in seconds.
 *
 * A menu rather than a number and a unit, because a delay is one of a handful
 * of real answers — now, later today, in a few days — and the arithmetic of
 * "90 minutes" is a worse version of "in 2 hours". Every entry is a whole
 * number of seconds inside `MAX_DELAY_SECONDS`, so nothing here can be refused
 * by `parseDelay`. A rule needing some other delay can still carry one: the
 * column is seconds and the parser takes any of them.
 */
export const DELAY_CHOICES: readonly { seconds: number; label: string }[] = [
  { seconds: 0, label: "Immediately" },
  { seconds: 60 * 15, label: "After 15 minutes" },
  { seconds: 60 * 60, label: "After 1 hour" },
  { seconds: 60 * 60 * 24, label: "After 1 day" },
  { seconds: 60 * 60 * 24 * 3, label: "After 3 days" },
  { seconds: 60 * 60 * 24 * 7, label: "After 7 days" },
  { seconds: MAX_DELAY_SECONDS, label: "After 30 days" },
];

/**
 * A delay in words, for a rule whose delay is not one of the choices.
 *
 * Falls through to seconds rather than rounding: a rule saved with 90 seconds
 * through the API should read as 90 seconds, not as "after 1 minute".
 */
export function describeDelay(seconds: number): string {
  const choice = DELAY_CHOICES.find((option) => option.seconds === seconds);
  if (choice) return choice.label;
  if (seconds % (60 * 60 * 24) === 0) return `After ${seconds / (60 * 60 * 24)} days`;
  if (seconds % (60 * 60) === 0) return `After ${seconds / (60 * 60)} hours`;
  if (seconds % 60 === 0) return `After ${seconds / 60} minutes`;
  return `After ${seconds} seconds`;
}

/**
 * A relative date in words.
 *
 * Here beside `describeDelay` rather than in the component, for the reason the
 * whole sentence is: the list and the form's preview must not describe the same
 * rule differently, and a phrase that reads wrongly is indistinguishable from a
 * rule that is wrong. The two anchors have to *sound* different — "in 3 days"
 * and "3 days later than it is" are different rules, and a sentence that
 * blurred them would hide the only thing somebody is checking.
 */
export function describeRelativeDate(value: RelativeDate): string {
  const magnitude = Math.abs(value.days) === 1 ? "1 day" : `${Math.abs(value.days)} days`;

  if (value.from === "now") {
    if (value.days === 0) return "today";
    return value.days > 0 ? `${magnitude} from now` : `${magnitude} ago`;
  }

  if (value.days === 0) return "the day it already falls on";
  return value.days > 0
    ? `${magnitude} later than it is`
    : `${magnitude} earlier than it is`;
}

/**
 * A rule in one sentence.
 *
 * **Here rather than in the component** so the list and the form's preview
 * cannot describe the same rule differently, and so the phrasing is unit
 * tested — it is the only part of this screen that says what a rule *does*,
 * and a sentence that reads wrongly is indistinguishable from a rule that is
 * wrong.
 *
 * `names` resolves an id to something a person recognises. It takes the
 * `ValueInput` as well as the value because an id alone does not say which
 * table it came from — the same uuid shape is a status, a person or a list.
 */
export function describeRule(
  rule: AutomationRule,
  names: (input: ValueInput, value: unknown) => string,
): string {
  const parts = [describeTrigger(rule.trigger, names)];

  // One condition makes AND and OR the same rule, so they say the same thing;
  // with more than one the combinator is the difference between two rules and
  // the sentence has to carry it.
  const conditions = rule.conditions.conditions?.length ?? 0;
  if (conditions === 1) {
    parts.push("if 1 condition matches");
  } else if (conditions > 1) {
    parts.push(
      rule.conditions.op === "OR"
        ? `if any of ${conditions} conditions match`
        : `if ${conditions} conditions match`,
    );
  }

  if (rule.delaySeconds > 0) parts.push(describeDelay(rule.delaySeconds).toLowerCase());

  parts.push(rule.actions.map((action) => describeAction(action, names)).join(", then "));

  return parts.join(", ");
}

function describeTrigger(
  trigger: AutomationTrigger,
  names: (input: ValueInput, value: unknown) => string,
): string {
  switch (trigger.kind) {
    case "taskCreated":
      return "When a task is created";

    case "taskArchived":
      return "When a task is archived";

    case "commentAdded":
      return "When a comment is added";

    case "fieldChanged": {
      const field = AUTOMATABLE_FIELDS.find((candidate) => candidate.field === trigger.field);
      const label = field?.label ?? trigger.field;
      const input = field?.input ?? "text";
      // The narrowings read as the sentence they are: no `to` means any change,
      // which is a different rule and has to look like one.
      if ("to" in trigger && "from" in trigger) {
        return `When ${label} changes from ${names(input, trigger.from)} to ${names(input, trigger.to)}`;
      }
      if ("to" in trigger) return `When ${label} becomes ${names(input, trigger.to)}`;
      if ("from" in trigger) return `When ${label} stops being ${names(input, trigger.from)}`;
      return `When ${label} changes`;
    }

    case "relationAdded":
    case "relationRemoved": {
      const verb = trigger.kind === "relationAdded" ? "is added" : "is removed";
      const noun = RELATION_LABELS[trigger.relation].toLowerCase();
      if (trigger.targetId) {
        return `When ${names(relationInput(trigger.relation), trigger.targetId)} ${verb} as ${noun}`;
      }
      return `When any ${noun} ${verb}`;
    }

    default: {
      const exhaustive: never = trigger;
      throw new AutomationError(`No description for trigger: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function describeAction(
  action: AutomationAction,
  names: (input: ValueInput, value: unknown) => string,
): string {
  switch (action.kind) {
    case "setField": {
      const field = AUTOMATABLE_FIELDS.find((candidate) => candidate.field === action.field);
      const label = field?.label ?? action.field;
      // A relative date has no id to look up — it is arithmetic, and `names`
      // would print the object.
      if (isRelativeDate(action.to)) return `set ${label} to ${describeRelativeDate(action.to)}`;
      return `set ${label} to ${names(field?.input ?? "text", action.to)}`;
    }

    case "addRelation":
      return `add ${names(relationInput(action.relation), action.targetId)} as ${RELATION_LABELS[
        action.relation
      ].toLowerCase()}`;

    case "removeRelation":
      return `remove ${names(relationInput(action.relation), action.targetId)} as ${RELATION_LABELS[
        action.relation
      ].toLowerCase()}`;

    case "comment":
      return `comment “${action.text}”`;

    case "archive":
      return "archive the task";

    default: {
      const exhaustive: never = action;
      throw new AutomationError(`No description for action: ${JSON.stringify(exhaustive)}`);
    }
  }
}
