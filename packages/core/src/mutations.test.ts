import { describe, expect, it } from "vitest";

import {
  UndoStack,
  activityVerb,
  describeBatch,
  invert,
  invertBatch,
  isNoop,
  type Operation,
} from "./mutations";

const TASK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const setStatus: Operation = {
  kind: "setField",
  taskId: TASK,
  field: "statusId",
  from: "todo",
  to: "doing",
};

describe("invert", () => {
  it("swaps from and to on a field change", () => {
    expect(invert(setStatus)).toEqual({ ...setStatus, from: "doing", to: "todo" });
  });

  it("round-trips: inverting twice returns the original", () => {
    expect(invert(invert(setStatus))).toEqual(setStatus);
  });

  it("turns an add into a remove and back", () => {
    const add: Operation = {
      kind: "addRelation",
      taskId: TASK,
      relation: "assignee",
      targetId: USER,
    };
    expect(invert(add).kind).toBe("removeRelation");
    expect(invert(invert(add))).toEqual(add);
  });

  it("inverts a creation to an archive, not a delete", () => {
    // Undoing a create must itself be undoable. A hard delete would not be.
    const create: Operation = {
      kind: "createTask",
      taskId: TASK,
      listId: "list",
      values: { name: "New" },
    };
    expect(invert(create)).toEqual({ kind: "archiveTask", taskId: TASK });
    expect(invert(invert(create))).toEqual({ kind: "restoreTask", taskId: TASK });
  });

  it("handles null on either side of a field change", () => {
    const clearDue: Operation = {
      kind: "setField",
      taskId: TASK,
      field: "dueAt",
      from: new Date("2026-01-01"),
      to: null,
    };
    const undone = invert(clearDue) as typeof clearDue;
    expect(undone.to).toEqual(new Date("2026-01-01"));
    expect(undone.from).toBeNull();
  });
});

describe("invertBatch", () => {
  it("reverses the order as well as each operation", () => {
    // Order matters: operations in a batch can depend on each other, so undo
    // has to run backwards.
    const a: Operation = { ...setStatus, taskId: "a" };
    const b: Operation = { ...setStatus, taskId: "b" };
    const c: Operation = { ...setStatus, taskId: "c" };

    const undone = invertBatch([a, b, c]);
    expect(undone.map((op) => (op as typeof a).taskId)).toEqual(["c", "b", "a"]);
  });

  it("round-trips a batch", () => {
    const batch = [setStatus, { ...setStatus, taskId: "other" }];
    expect(invertBatch(invertBatch(batch))).toEqual(batch);
  });

  it("does not mutate the input array", () => {
    const batch = [setStatus, { ...setStatus, taskId: "other" }];
    const copy = [...batch];
    invertBatch(batch);
    expect(batch).toEqual(copy);
  });
});

describe("isNoop", () => {
  it("flags setting a value to what it already is", () => {
    expect(isNoop({ ...setStatus, from: "todo", to: "todo" })).toBe(true);
  });

  it("compares dates by value, not identity", () => {
    expect(
      isNoop({
        kind: "setField",
        taskId: TASK,
        field: "dueAt",
        from: new Date("2026-01-01"),
        to: new Date("2026-01-01"),
      }),
    ).toBe(true);
  });

  it("treats null and undefined as the same absence", () => {
    expect(
      isNoop({ kind: "setField", taskId: TASK, field: "dueAt", from: null, to: undefined }),
    ).toBe(true);
  });

  it("does not flag a real change", () => {
    expect(isNoop(setStatus)).toBe(false);
  });
});

describe("activityVerb", () => {
  it("derives a snake_case verb from the field", () => {
    expect(activityVerb(setStatus)).toBe("task.status_id_changed");
    expect(activityVerb({ ...setStatus, field: "dueAt" })).toBe("task.due_at_changed");
  });

  it("distinguishes add from remove", () => {
    expect(
      activityVerb({ kind: "addRelation", taskId: TASK, relation: "tag", targetId: "t" }),
    ).toBe("task.tag_added");
  });
});

describe("describeBatch", () => {
  it("collapses a uniform batch into one phrase", () => {
    const ops = Array.from({ length: 12 }, (_, i) => ({ ...setStatus, taskId: `t${i}` }));
    expect(describeBatch(ops)).toBe("Changed status on 12 tasks");
  });

  it("falls back to a count for a mixed batch", () => {
    expect(
      describeBatch([setStatus, { kind: "archiveTask", taskId: TASK }]),
    ).toBe("2 changes");
  });

  it("handles an empty batch", () => {
    expect(describeBatch([])).toBe("Nothing to undo");
  });
});

describe("UndoStack", () => {
  it("returns the batch it was given, unchanged", () => {
    const stack = new UndoStack();
    // What a server action hands back: already the inverse.
    stack.push([{ ...setStatus, from: "doing", to: "todo" }]);

    const undone = stack.pop();
    expect(undone?.[0]).toMatchObject({ from: "doing", to: "todo" });
    expect(stack.depth).toBe(0);
  });

  it("does not invert what it stores — the round trip returns to the start", () => {
    // The exact composition that was broken (D-049). The server applied
    // todo → doing and handed back its inverse; the stack inverted it a second
    // time, so pressing undo re-applied todo → doing. The row never moved and
    // the toast still reported success.
    const applied: Operation = { ...setStatus, from: "todo", to: "doing" };
    const fromServer = invert(applied);

    const stack = new UndoStack();
    stack.push([fromServer]);

    const toApply = stack.pop();
    expect(toApply?.[0]).toMatchObject({ from: "doing", to: "todo" });
  });

  it("holds the inverse of a creation, not another creation", () => {
    const stack = new UndoStack();
    // createTask inverts to archiveTask on the server; the client stores that.
    stack.push([{ kind: "archiveTask", taskId: TASK }]);
    expect(stack.pop()?.[0]).toMatchObject({ kind: "archiveTask" });
  });

  it("returns undefined when empty", () => {
    expect(new UndoStack().pop()).toBeUndefined();
  });

  it("does not record a no-op", () => {
    const stack = new UndoStack();
    stack.push([{ ...setStatus, from: "todo", to: "todo" }]);
    // Clicking the status a task already has must not occupy an undo slot.
    expect(stack.depth).toBe(0);
  });

  it("keeps the meaningful operations from a partly-noop batch", () => {
    const stack = new UndoStack();
    stack.push([{ ...setStatus, from: "todo", to: "todo" }, setStatus]);
    expect(stack.depth).toBe(1);
    expect(stack.pop()).toHaveLength(1);
  });

  it("drops the oldest entry past the limit", () => {
    const stack = new UndoStack(3);
    for (let i = 0; i < 5; i++) stack.push([{ ...setStatus, taskId: `t${i}` }]);

    expect(stack.depth).toBe(3);
    // Oldest two evicted; the newest is on top.
    expect(stack.pop()?.[0]).toMatchObject({ taskId: "t4" });
  });

  it("describes what would be undone", () => {
    const stack = new UndoStack();
    stack.push([setStatus, { ...setStatus, taskId: "b" }]);
    expect(stack.peekDescription()).toBe("Changed status on 2 tasks");
  });

  it("unwinds in reverse", () => {
    const stack = new UndoStack();
    stack.push([{ ...setStatus, taskId: "first" }]);
    stack.push([{ ...setStatus, taskId: "second" }]);

    expect(stack.pop()?.[0]).toMatchObject({ taskId: "second" });
    expect(stack.pop()?.[0]).toMatchObject({ taskId: "first" });
    expect(stack.pop()).toBeUndefined();
  });
});
