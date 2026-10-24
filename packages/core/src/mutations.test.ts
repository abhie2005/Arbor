import { describe, expect, it } from "vitest";

import {
  MutationError,
  UndoStack,
  activityVerb,
  describeBatch,
  invert,
  invertBatch,
  isNoop,
  type Operation,
  parseOperation,
  parseOperations,
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

describe("describeBatch counts tasks, not operations", () => {
  const move: Operation[] = [
    { kind: "setField", taskId: TASK, field: "statusId", from: "a", to: "b" },
    { kind: "setField", taskId: TASK, field: "position", from: "a0", to: "a1" },
  ];

  it("names the fields when one task changed in several ways", () => {
    // One drag on the board. This used to read "Changed order on 2 tasks",
    // which was the wrong count and the wrong noun.
    expect(describeBatch(move)).toBe("Changed status and order");
  });

  it("counts distinct tasks in a bulk edit, not operations", () => {
    const bulk: Operation[] = [
      { kind: "setField", taskId: "t1", field: "statusId", from: "a", to: "b" },
      { kind: "setField", taskId: "t1", field: "priority", from: 1, to: 2 },
      { kind: "setField", taskId: "t2", field: "statusId", from: "a", to: "b" },
      { kind: "setField", taskId: "t2", field: "priority", from: 1, to: 2 },
    ];
    expect(describeBatch(bulk)).toBe("Changed status on 2 tasks");
  });

  it("still describes a single operation on its own", () => {
    expect(describeBatch([move[0]!])).toBe("Changed status");
  });

  it("falls back to a count when one task changed in mixed ways", () => {
    expect(
      describeBatch([
        { kind: "setField", taskId: TASK, field: "name", from: "a", to: "b" },
        { kind: "addRelation", taskId: TASK, relation: "assignee", targetId: USER },
      ]),
    ).toBe("2 changes");
  });
});

describe("comment operations", () => {
  const body = { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "hi" }] }] };

  it("inverts a post into a delete", () => {
    expect(invert({ kind: "createComment", commentId: "c1", taskId: "t1", body, parentId: null })).toEqual({
      kind: "deleteComment",
      commentId: "c1",
      taskId: "t1",
    });
  });

  // Soft, so undoing an undo brings the comment back rather than losing what
  // someone wrote — the same reason archiveTask does not invert to a delete.
  it("inverts a delete into a restore, and back again", () => {
    const deleted = invert({ kind: "deleteComment", commentId: "c1", taskId: "t1" });
    expect(deleted).toEqual({ kind: "restoreComment", commentId: "c1", taskId: "t1" });
    expect(invert(deleted)).toEqual({ kind: "deleteComment", commentId: "c1", taskId: "t1" });
  });

  it("inverts an edit by swapping the documents", () => {
    const after = { type: "doc" as const, content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: "bye" }] }] };
    expect(invert({ kind: "editComment", commentId: "c1", taskId: "t1", from: body, to: after })).toEqual({
      kind: "editComment",
      commentId: "c1",
      taskId: "t1",
      from: after,
      to: body,
    });
  });

  it("treats an edit that changes nothing as a no-op", () => {
    const same = JSON.parse(JSON.stringify(body)) as typeof body;
    expect(isNoop({ kind: "editComment", commentId: "c1", taskId: "t1", from: body, to: same })).toBe(true);
  });

  it("carries a task id, because that is what authorization is scoped to", () => {
    const ops = [
      { kind: "createComment" as const, commentId: "c1", taskId: "t1", body, parentId: null },
      { kind: "deleteComment" as const, commentId: "c2", taskId: "t2" },
    ];
    expect(ops.map((op) => op.taskId)).toEqual(["t1", "t2"]);
  });

  it("names each one in the activity log", () => {
    expect(activityVerb({ kind: "createComment", commentId: "c1", taskId: "t1", body, parentId: null })).toBe("comment.added");
    expect(activityVerb({ kind: "deleteComment", commentId: "c1", taskId: "t1" })).toBe("comment.deleted");
    expect(activityVerb({ kind: "restoreComment", commentId: "c1", taskId: "t1" })).toBe("comment.restored");
  });
});

describe("time entries as operations", () => {
  const ENTRY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const started = "2026-09-09T10:00:00.000Z";
  const ended = "2026-09-09T11:30:00.000Z";

  const running: Operation = {
    kind: "createTimeEntry",
    entryId: ENTRY,
    taskId: TASK,
    userId: USER,
    values: { startedAt: started, endedAt: null, description: null, isBillable: false },
  };

  const stop: Operation = {
    kind: "setTimeEntry",
    entryId: ENTRY,
    taskId: TASK,
    from: { startedAt: started, endedAt: null, description: null, isBillable: false },
    to: { startedAt: started, endedAt: ended, description: null, isBillable: false },
  };

  // There is no soft delete on time_entries, so the row has to travel with the
  // operation or undo would restore an entry rather than *the* entry.
  it("inverts a creation into a delete that carries the row back", () => {
    const undone = invert(running);
    expect(undone).toEqual({
      kind: "deleteTimeEntry",
      entryId: ENTRY,
      taskId: TASK,
      userId: USER,
      values: { startedAt: started, endedAt: null, description: null, isBillable: false },
    });
    expect(invert(undone)).toEqual(running);
  });

  it("undoes a stop by putting the end back to null, which is running again", () => {
    const undone = invert(stop);
    expect(undone.kind).toBe("setTimeEntry");
    expect((undone as typeof stop).to.endedAt).toBeNull();
    expect(invert(undone)).toEqual(stop);
  });

  // One operation, two verbs. A history that called both "logged time" would
  // lose the only distinction endedAt makes.
  it("names starting and logging differently in the log", () => {
    expect(activityVerb(running)).toBe("task.timer_started");
    expect(
      activityVerb({
        ...running,
        values: { startedAt: started, endedAt: ended, description: null, isBillable: false },
      } as Operation),
    ).toBe("task.time_logged");
  });

  it("names a stop as a stop and any other edit as an edit", () => {
    expect(activityVerb(stop)).toBe("task.timer_stopped");
    expect(
      activityVerb({
        ...stop,
        from: { startedAt: started, endedAt: ended, description: null, isBillable: false },
        to: { startedAt: started, endedAt: ended, description: "写", isBillable: true },
      } as Operation),
    ).toBe("task.time_changed");
  });

  it("treats a save that changed nothing as a no-op", () => {
    // Every save from a form builds fresh Date objects, so identity comparison
    // would call reopening and closing the editor a change.
    expect(
      isNoop({
        ...stop,
        from: { startedAt: started, endedAt: ended, description: null, isBillable: false },
        to: { startedAt: "2026-09-09T10:00:00Z", endedAt: "2026-09-09T11:30:00Z", description: null, isBillable: false },
      } as Operation),
    ).toBe(true);
  });

  it("carries a task id, because that is what authorization is scoped to", () => {
    // The column is nullable in the schema; an entry against no task would be a
    // write `undo` could not check.
    expect([running, stop, invert(running)].map((op) => op.taskId)).toEqual([TASK, TASK, TASK]);
  });

  /**
   * The one that was missing.
   *
   * An operation is not a value in this process — it is handed to the client as
   * an inverse, held on the undo stack, and posted back to be applied. So it
   * has to survive JSON, and a `Date` does not: it arrives as a string, and
   * every helper that called `.getTime()` on it threw where nothing could see
   * it (D-097). Nothing else in the union had noticed, because nothing else
   * stored a typed Date.
   */
  it("survives the round trip an undo actually makes", () => {
    for (const op of [running, stop, invert(running)]) {
      const wire = JSON.parse(JSON.stringify(op)) as Operation;

      expect(() => isNoop(wire)).not.toThrow();
      expect(() => activityVerb(wire)).not.toThrow();
      expect(() => invert(wire)).not.toThrow();
      expect(wire).toEqual(op);
    }
  });

  it("undoes 'start a second timer stops the first' in one batch, backwards", () => {
    const second = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const batch: Operation[] = [
      stop,
      { ...running, entryId: second, values: { startedAt: ended, endedAt: null, description: null, isBillable: false } } as Operation,
    ];

    const undone = invertBatch(batch);
    // The new entry is removed before the old one is restarted, or there would
    // be an instant with two running timers for one person.
    expect(undone.map((op) => op.kind)).toEqual(["deleteTimeEntry", "setTimeEntry"]);
  });
});

describe("parsing an operation off the wire", () => {
  // `Operation` is a type and types are erased, so until `parseOperations`
  // existed nothing checked one at runtime — `undo` has taken client-supplied
  // operations since Phase 2 on the strength of an annotation, and the public
  // API made the same payload reachable with a bearer token (D-134).
  const FIELD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const LIST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const COMMENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const ENTRY = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] };

  /** Every kind, in the shape the app and the executor already agree on. */
  const examples: Operation[] = [
    { kind: "setField", taskId: TASK, field: "statusId", from: null, to: "x" },
    { kind: "setCustomField", taskId: TASK, fieldId: FIELD, from: null, to: ["a", "b"] },
    { kind: "addRelation", taskId: TASK, relation: "assignee", targetId: USER },
    { kind: "removeRelation", taskId: TASK, relation: "tag", targetId: FIELD },
    {
      kind: "createTask",
      taskId: TASK,
      listId: LIST,
      values: { name: "A task", position: "a0", spaceId: LIST, folderId: null, statusId: null, priority: null },
    },
    { kind: "archiveTask", taskId: TASK },
    { kind: "restoreTask", taskId: TASK },
    { kind: "createComment", commentId: COMMENT, taskId: TASK, body: doc as never, parentId: null },
    { kind: "deleteComment", commentId: COMMENT, taskId: TASK },
    { kind: "restoreComment", commentId: COMMENT, taskId: TASK },
    { kind: "editComment", commentId: COMMENT, taskId: TASK, from: doc as never, to: doc as never },
    { kind: "setDescription", taskId: TASK, from: null, to: doc as never },
    {
      kind: "createTimeEntry",
      entryId: ENTRY,
      taskId: TASK,
      userId: USER,
      values: { startedAt: "2026-10-24T10:00:00.000Z", endedAt: null, description: null, isBillable: false },
    },
    {
      kind: "setTimeEntry",
      entryId: ENTRY,
      taskId: TASK,
      from: { startedAt: "2026-10-24T10:00:00.000Z", endedAt: null, description: null, isBillable: false },
      to: { startedAt: "2026-10-24T10:00:00.000Z", endedAt: "2026-10-24T11:00:00.000Z", description: "x", isBillable: true },
    },
    {
      kind: "deleteTimeEntry",
      entryId: ENTRY,
      taskId: TASK,
      userId: USER,
      values: { startedAt: "2026-10-24T10:00:00.000Z", endedAt: null, description: null, isBillable: false },
    },
  ];

  it("accepts every kind the executor can apply, through JSON", () => {
    // Through `JSON.parse(JSON.stringify(…))` on purpose: invariant 10 says an
    // operation has to survive the wire, and this is that trip.
    for (const op of examples) {
      expect(parseOperation(JSON.parse(JSON.stringify(op)))).toEqual(op);
    }
  });

  it("covers every kind, so a new one cannot be added without a test here", () => {
    // Fifteen `kind` strings across twelve interfaces: `RelationOp`,
    // `ArchiveOp` and `CommentLifecycleOp` each cover more than one, because
    // add/remove and archive/restore are the same shape with the sign flipped.
    expect([...new Set(examples.map((op) => op.kind))].sort()).toEqual([
      "addRelation",
      "archiveTask",
      "createComment",
      "createTask",
      "createTimeEntry",
      "deleteComment",
      "deleteTimeEntry",
      "editComment",
      "removeRelation",
      "restoreComment",
      "restoreTask",
      "setCustomField",
      "setDescription",
      "setField",
      "setTimeEntry",
    ]);
  });

  it("returns operations that still invert, which is what the API hands back", () => {
    for (const op of examples) {
      expect(() => invert(parseOperation(JSON.parse(JSON.stringify(op))))).not.toThrow();
    }
  });

  it("refuses a kind the executor's switch does not handle", () => {
    expect(() => parseOperation({ kind: "dropTable", taskId: TASK })).toThrow(MutationError);
    expect(() => parseOperation({ taskId: TASK })).toThrow(MutationError);
  });

  it("refuses a field outside the closed map, because each one is a column", () => {
    expect(() =>
      parseOperation({ kind: "setField", taskId: TASK, field: "workspaceId", from: null, to: "x" }),
    ).toThrow(/is not a task field/);
    expect(() =>
      parseOperation({ kind: "setField", taskId: TASK, field: "name; DROP", from: null, to: "x" }),
    ).toThrow(/is not a task field/);
  });

  it("refuses a value that is not a scalar where a column is", () => {
    expect(() =>
      parseOperation({ kind: "setField", taskId: TASK, field: "priority", from: null, to: { a: 1 } }),
    ).toThrow(/is not a string, number, boolean or null/);
    expect(() =>
      parseOperation({ kind: "setField", taskId: TASK, field: "priority", from: null, to: [1] }),
    ).toThrow(MutationError);
  });

  it("allows a list for a custom field, which is what a multi-select stores", () => {
    const parsed = parseOperation({
      kind: "setCustomField",
      taskId: TASK,
      fieldId: FIELD,
      from: null,
      to: ["a"],
    });
    expect(parsed).toMatchObject({ to: ["a"] });
  });

  it("refuses an id that is not a uuid", () => {
    expect(() => parseOperation({ kind: "archiveTask", taskId: "1 OR 1=1" })).toThrow(/is not a uuid/);
    expect(() => parseOperation({ kind: "archiveTask", taskId: "" })).toThrow(/is not a uuid/);
    expect(() => parseOperation({ kind: "archiveTask" })).toThrow(/is not a uuid/);
  });

  it("refuses a relation that is not one of the three sets", () => {
    expect(() =>
      parseOperation({ kind: "addRelation", taskId: TASK, relation: "owner", targetId: USER }),
    ).toThrow(/assignee, a watcher or a tag/);
  });

  it("refuses a document that is not one", () => {
    expect(() =>
      parseOperation({ kind: "createComment", commentId: COMMENT, taskId: TASK, body: "hello", parentId: null }),
    ).toThrow(/is not a document/);
    expect(() =>
      parseOperation({
        kind: "createComment",
        commentId: COMMENT,
        taskId: TASK,
        body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text" }] }] },
        parentId: null,
      }),
    ).toThrow(/is not a document/);
  });

  it("refuses time values that are the wrong shape, and leaves the semantics to validateTimeEntry", () => {
    expect(() =>
      parseOperation({
        kind: "createTimeEntry",
        entryId: ENTRY,
        taskId: TASK,
        userId: USER,
        values: { startedAt: 0, endedAt: null, description: null, isBillable: false },
      }),
    ).toThrow(/is not a string/);
  });

  it("refuses a createTask with nothing to create", () => {
    expect(() =>
      parseOperation({ kind: "createTask", taskId: TASK, listId: LIST, values: {} }),
    ).toThrow(/values.name is not a string/);
  });

  it("takes a batch, and an empty one means nothing to do", () => {
    expect(parseOperations([])).toEqual([]);
    expect(parseOperations(JSON.parse(JSON.stringify(examples)))).toHaveLength(examples.length);
  });

  it("names the operation that is wrong, so a 400 can say which", () => {
    expect(() => parseOperations([examples[0], { kind: "nope" }])).toThrow(/operations\[1\]/);
  });

  it("refuses a batch that is not an array, and one that is absurdly long", () => {
    expect(() => parseOperations({ 0: examples[0] })).toThrow(/is not an array/);
    expect(() =>
      parseOperations(Array.from({ length: 201 }, () => JSON.parse(JSON.stringify(examples[5])))),
    ).toThrow(/more than 200/);
  });
});
