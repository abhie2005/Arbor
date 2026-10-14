import { describe, expect, it } from "vitest";

import {
  type AutomationEvent,
  type AutomationRule,
  type TaskSnapshot,
  AutomationError,
  MAX_DELAY_SECONDS,
  MAX_DEPTH,
  compileActions,
  depthOf,
  idempotencyKeyFor,
  matches,
  parseAutomationRule,
  runVerdict,
  verbFor,
} from "./automations";
import { activityVerb } from "./mutations";

const TASK = "11111111-1111-4111-8111-111111111111";
const RILEY = "22222222-2222-4222-8222-222222222222";
const DONE = "33333333-3333-4333-8333-333333333333";

const rule = (over: Partial<AutomationRule> = {}): AutomationRule => ({
  trigger: { kind: "fieldChanged", field: "statusId", to: DONE },
  conditions: { op: "AND", conditions: [] },
  actions: [{ kind: "archive" }],
  appliesTo: "tasks",
  delaySeconds: 0,
  ...over,
});

const event = (over: Partial<AutomationEvent> = {}): AutomationEvent => ({
  activityId: "1",
  verb: "task.status_id_changed",
  from: null,
  to: DONE,
  taskId: TASK,
  actorId: RILEY,
  isSubtask: false,
  ...over,
});

const snapshot = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id: TASK,
  name: "Webhook signature verification",
  statusId: null,
  priority: null,
  dueAt: null,
  startAt: null,
  points: null,
  timeEstimateMs: null,
  taskTypeId: null,
  parentTaskId: null,
  homeListId: "44444444-4444-4444-8444-444444444444",
  assignees: [],
  watchers: [],
  tags: [],
  ...over,
});

describe("a trigger is named by the function that writes the name", () => {
  // The whole point of computing the verb rather than storing it: rename the
  // verb an operation logs and every trigger follows, instead of silently
  // listening for a string nothing emits any more.
  it("agrees with activityVerb for a field change", () => {
    expect(verbFor({ kind: "fieldChanged", field: "statusId" })).toBe(
      activityVerb({ kind: "setField", taskId: TASK, field: "statusId", from: null, to: null }),
    );
    expect(verbFor({ kind: "fieldChanged", field: "statusId" })).toBe("task.status_id_changed");
  });

  it("spells the column name, not the operation's", () => {
    // CLAUDE.md's warning, as an assertion: the log stores `due_at`.
    expect(verbFor({ kind: "fieldChanged", field: "dueAt" })).toBe("task.due_at_changed");
  });

  it("agrees for relations, creation and comments", () => {
    expect(verbFor({ kind: "relationAdded", relation: "assignee" })).toBe("task.assignee_added");
    expect(verbFor({ kind: "relationRemoved", relation: "tag" })).toBe("task.tag_removed");
    expect(verbFor({ kind: "taskCreated" })).toBe("task.created");
    expect(verbFor({ kind: "taskArchived" })).toBe("task.archived");
    expect(verbFor({ kind: "commentAdded" })).toBe("comment.added");
  });
});

describe("matching", () => {
  it("ignores an event with another verb", () => {
    expect(matches(rule(), event({ verb: "task.priority_changed" }))).toBe(false);
  });

  it("fires when the narrowed value is the one that arrived", () => {
    expect(matches(rule(), event())).toBe(true);
  });

  it("does not fire when the status moved somewhere else", () => {
    expect(matches(rule(), event({ to: "99999999-9999-4999-8999-999999999999" }))).toBe(false);
  });

  // The absence of `to` is the difference between "when it becomes Done" and
  // "whenever the status moves", which is why it is tested with `in`.
  it("fires on any change when nothing is narrowed", () => {
    const any = rule({ trigger: { kind: "fieldChanged", field: "statusId" } });
    expect(matches(any, event({ to: "anything" }))).toBe(true);
  });

  it("narrows on the old value too", () => {
    const fromDone = rule({
      trigger: { kind: "fieldChanged", field: "statusId", from: DONE },
    });
    expect(matches(fromDone, event({ from: DONE }))).toBe(true);
    expect(matches(fromDone, event({ from: null }))).toBe(false);
  });

  // A priority written by a form is "3" and the column holds 3. Comparing with
  // === would make a rule that passes its test fail against Postgres.
  it("treats a number and its string the same, because jsonb and a form disagree", () => {
    const priority = rule({ trigger: { kind: "fieldChanged", field: "priority", to: 3 } });
    expect(matches(priority, event({ verb: "task.priority_changed", to: "3" }))).toBe(true);
  });

  it("treats null and undefined as the same absence", () => {
    const cleared = rule({ trigger: { kind: "fieldChanged", field: "dueAt", to: null } });
    expect(matches(cleared, event({ verb: "task.due_at_changed", to: undefined }))).toBe(true);
  });

  it("narrows a relation to one person", () => {
    const mine = rule({
      trigger: { kind: "relationAdded", relation: "assignee", targetId: RILEY },
      actions: [{ kind: "archive" }],
    });
    expect(matches(mine, event({ verb: "task.assignee_added", to: RILEY }))).toBe(true);
    expect(matches(mine, event({ verb: "task.assignee_added", to: "someone" }))).toBe(false);
  });

  it("reads a removal's target from the old value, because that is what changed", () => {
    const gone = rule({
      trigger: { kind: "relationRemoved", relation: "assignee", targetId: RILEY },
    });
    expect(matches(gone, event({ verb: "task.assignee_removed", to: null, from: RILEY }))).toBe(true);
  });
});

describe("appliesTo is about the tree, so no condition could express it", () => {
  it("keeps a tasks-only rule off a subtask", () => {
    expect(matches(rule(), event({ isSubtask: true }))).toBe(false);
  });

  it("keeps a subtasks-only rule off a parent", () => {
    const subs = rule({ appliesTo: "subtasks" });
    expect(matches(subs, event({ isSubtask: false }))).toBe(false);
    expect(matches(subs, event({ isSubtask: true }))).toBe(true);
  });

  it("lets both through", () => {
    const both = rule({ appliesTo: "both" });
    expect(matches(both, event({ isSubtask: true }))).toBe(true);
    expect(matches(both, event({ isSubtask: false }))).toBe(true);
  });
});

describe("compiling actions to operations", () => {
  const ids = () => {
    let n = 0;
    return () => `id-${++n}`;
  };

  it("carries the current value as `from`, which is what makes it invertible", () => {
    const ops = compileActions(
      [{ kind: "setField", field: "statusId", to: DONE }],
      snapshot({ statusId: "todo" }),
      ids(),
    );
    expect(ops).toEqual([
      { kind: "setField", taskId: TASK, field: "statusId", from: "todo", to: DONE },
    ]);
  });

  // A rule that fires a hundred times and changes nothing should say so.
  it("drops a change the task already has", () => {
    const ops = compileActions(
      [{ kind: "setField", field: "statusId", to: DONE }],
      snapshot({ statusId: DONE }),
      ids(),
    );
    expect(ops).toEqual([]);
  });

  it("does not add somebody who is already there, or remove somebody who is not", () => {
    const already = compileActions(
      [{ kind: "addRelation", relation: "assignee", targetId: RILEY }],
      snapshot({ assignees: [RILEY] }),
      ids(),
    );
    expect(already).toEqual([]);

    const absent = compileActions(
      [{ kind: "removeRelation", relation: "assignee", targetId: RILEY }],
      snapshot({ assignees: [] }),
      ids(),
    );
    expect(absent).toEqual([]);
  });

  it("adds somebody who is not there yet", () => {
    const ops = compileActions(
      [{ kind: "addRelation", relation: "watcher", targetId: RILEY }],
      snapshot(),
      ids(),
    );
    expect(ops).toEqual([
      { kind: "addRelation", taskId: TASK, relation: "watcher", targetId: RILEY },
    ]);
  });

  // D-122's rule, from the other side: a rule's text is written once, so an
  // "@Name" in it must not bind to whoever held that name that day.
  it("writes a comment as a document and leaves @Name as text", () => {
    const ops = compileActions([{ kind: "comment", text: "Moved by @Riley Kaur" }], snapshot(), ids());
    expect(ops).toHaveLength(1);
    const op = ops[0] as { kind: string; commentId: string; body: unknown };
    expect(op.kind).toBe("createComment");
    expect(op.commentId).toBe("id-1");
    expect(JSON.stringify(op.body)).not.toContain('"type":"mention"');
  });

  it("archives", () => {
    expect(compileActions([{ kind: "archive" }], snapshot(), ids())).toEqual([
      { kind: "archiveTask", taskId: TASK },
    ]);
  });

  it("refuses a field an automation may not set", () => {
    expect(() =>
      compileActions(
        [{ kind: "setField", field: "position" as never, to: "a" }],
        snapshot(),
        ids(),
      ),
    ).toThrow(AutomationError);
  });
});

describe("the guards", () => {
  const base = { automationId: "a1", runsThisPeriod: 0, quota: 100 };

  it("lets an ordinary event run", () => {
    expect(runVerdict({ ...base, event: event() })).toBe("run");
  });

  // The one cycle that needs no counter: refusing it by depth would still let
  // it run three times first.
  it("never lets a rule answer its own output", () => {
    const own = event({ causedBy: { automationId: "a1", depth: 0 } });
    expect(runVerdict({ ...base, event: own })).toBe("skipped_self");
  });

  it("lets a different rule answer it, which is the cascade worth having", () => {
    const other = event({ causedBy: { automationId: "a2", depth: 0 } });
    expect(runVerdict({ ...base, event: other })).toBe("run");
  });

  it("refuses past the depth limit", () => {
    const deep = event({ causedBy: { automationId: "a2", depth: MAX_DEPTH } });
    expect(runVerdict({ ...base, event: deep })).toBe("refused_depth");
  });

  it("refuses a workspace that has spent its quota", () => {
    expect(runVerdict({ ...base, event: event(), runsThisPeriod: 100 })).toBe("refused_quota");
  });

  it("counts depth from the run that caused it", () => {
    expect(depthOf(event())).toBe(0);
    expect(depthOf(event({ causedBy: { automationId: "a2", depth: 0 } }))).toBe(1);
  });
});

describe("idempotency", () => {
  // The scan overlaps on purpose, because a lower activity id can commit after
  // a higher one. The key is what makes re-reading harmless.
  it("is the same key for the same rule and the same event", () => {
    expect(idempotencyKeyFor("a1", "500")).toBe(idempotencyKeyFor("a1", "500"));
    expect(idempotencyKeyFor("a1", "500")).not.toBe(idempotencyKeyFor("a2", "500"));
    expect(idempotencyKeyFor("a1", "500")).not.toBe(idempotencyKeyFor("a1", "501"));
  });
});

describe("validating a rule before it is stored", () => {
  const valid = {
    trigger: { kind: "fieldChanged", field: "statusId", to: DONE },
    actions: [{ kind: "comment", text: "  done  " }],
  };

  it("accepts a good rule and trims what it stores", () => {
    const parsed = parseAutomationRule(valid);
    expect(parsed.actions).toEqual([{ kind: "comment", text: "done" }]);
    expect(parsed.appliesTo).toBe("tasks");
    expect(parsed.conditions).toEqual({ op: "AND", conditions: [] });
  });

  it("keeps a narrowing that is explicitly null, because cleared is a value", () => {
    const parsed = parseAutomationRule({
      trigger: { kind: "fieldChanged", field: "dueAt", to: null },
      actions: [{ kind: "archive" }],
    });
    expect(parsed.trigger).toEqual({ kind: "fieldChanged", field: "dueAt", to: null });
  });

  it("refuses a rule with nothing to do", () => {
    expect(() => parseAutomationRule({ ...valid, actions: [] })).toThrow(AutomationError);
  });

  it("refuses a trigger nobody emits", () => {
    expect(() => parseAutomationRule({ ...valid, trigger: { kind: "whenever" } })).toThrow(
      AutomationError,
    );
  });

  it("refuses a field that is not a task's", () => {
    expect(() =>
      parseAutomationRule({ ...valid, trigger: { kind: "fieldChanged", field: "nonsense" } }),
    ).toThrow(AutomationError);
  });

  it("refuses a relation action with nobody to act on", () => {
    expect(() =>
      parseAutomationRule({ ...valid, actions: [{ kind: "addRelation", relation: "assignee" }] }),
    ).toThrow(AutomationError);
  });

  it("refuses a comment with nothing in it", () => {
    expect(() =>
      parseAutomationRule({ ...valid, actions: [{ kind: "comment", text: "   " }] }),
    ).toThrow(AutomationError);
  });

  it("refuses a scope that is not one", () => {
    expect(() => parseAutomationRule({ ...valid, appliesTo: "everything" })).toThrow(
      AutomationError,
    );
  });
});

describe("a delay is the rule's, and it is validated before it is stored", () => {
  const valid = {
    trigger: { kind: "fieldChanged", field: "statusId" },
    actions: [{ kind: "archive" }],
  };

  it("defaults to acting immediately, which is what every rule did before", () => {
    expect(parseAutomationRule(valid).delaySeconds).toBe(0);
  });

  it("keeps a delay somebody asked for", () => {
    expect(parseAutomationRule({ ...valid, delaySeconds: 3 * 24 * 3600 }).delaySeconds).toBe(259200);
  });

  // Clamping a negative delay to zero would turn a rule somebody wrote badly
  // into a *different* rule running in production, which is worse than refusing.
  it("refuses a negative delay rather than quietly making it immediate", () => {
    expect(() => parseAutomationRule({ ...valid, delaySeconds: -1 })).toThrow(AutomationError);
  });

  it("refuses a fractional one, because the column is whole seconds", () => {
    expect(() => parseAutomationRule({ ...valid, delaySeconds: 1.5 })).toThrow(AutomationError);
  });

  it("refuses one longer than a pending row should outlive", () => {
    expect(() =>
      parseAutomationRule({ ...valid, delaySeconds: MAX_DELAY_SECONDS + 1 }),
    ).toThrow(AutomationError);
    expect(parseAutomationRule({ ...valid, delaySeconds: MAX_DELAY_SECONDS }).delaySeconds).toBe(
      MAX_DELAY_SECONDS,
    );
  });

  it("refuses something that is not a number at all", () => {
    expect(() => parseAutomationRule({ ...valid, delaySeconds: "3 days" })).toThrow(
      AutomationError,
    );
  });
});
