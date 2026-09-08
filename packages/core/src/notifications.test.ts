import { describe, expect, it } from "vitest";

import type { Operation } from "./mutations";
import { recipientsFor } from "./notifications";
import { parseRichText } from "./richtext";

const people = [
  { id: "riley", name: "Riley Kaur" },
  { id: "sam", name: "Sam Petrov" },
  { id: "avery", name: "Avery Mills" },
];

const doc = (text: string) => parseRichText(text, people);
const comment = (text: string, parentId: string | null = null): Operation => ({
  kind: "createComment",
  commentId: "c1",
  taskId: "t1",
  body: doc(text),
  parentId,
});

describe("being assigned", () => {
  it("notifies the person assigned", () => {
    const op: Operation = {
      kind: "addRelation",
      taskId: "t1",
      relation: "assignee",
      targetId: "riley",
    };
    expect(recipientsFor(op, { actorId: "sam" })).toEqual([
      { userId: "riley", kind: "assigned" },
    ]);
  });

  it("says nothing when you assign yourself", () => {
    const op: Operation = {
      kind: "addRelation",
      taskId: "t1",
      relation: "assignee",
      targetId: "sam",
    };
    expect(recipientsFor(op, { actorId: "sam" })).toEqual([]);
  });

  /**
   * Watchers are the read-time half. Fanning out to them here is the exact
   * shape the table's design note rules out — a task with 200 watchers writing
   * 200 rows per edit.
   */
  it("does not notify a watcher being added", () => {
    const op: Operation = {
      kind: "addRelation",
      taskId: "t1",
      relation: "watcher",
      targetId: "riley",
    };
    expect(recipientsFor(op, { actorId: "sam" })).toEqual([]);
  });

  it("says nothing when an assignee is removed", () => {
    const op: Operation = {
      kind: "removeRelation",
      taskId: "t1",
      relation: "assignee",
      targetId: "riley",
    };
    expect(recipientsFor(op, { actorId: "sam" })).toEqual([]);
  });
});

describe("being mentioned", () => {
  it("notifies everyone a comment names", () => {
    expect(recipientsFor(comment("@Riley Kaur and @Avery Mills"), { actorId: "sam" })).toEqual([
      { userId: "riley", kind: "mentioned" },
      { userId: "avery", kind: "mentioned" },
    ]);
  });

  it("does not notify you for naming yourself", () => {
    expect(recipientsFor(comment("@Sam Petrov will do it"), { actorId: "sam" })).toEqual([]);
  });

  it("notifies someone named twice once", () => {
    expect(recipientsFor(comment("@Riley Kaur, @Riley Kaur"), { actorId: "sam" })).toEqual([
      { userId: "riley", kind: "mentioned" },
    ]);
  });

  it("says nothing for a comment that names nobody", () => {
    expect(recipientsFor(comment("Looks right"), { actorId: "sam" })).toEqual([]);
  });
});

describe("being replied to", () => {
  it("notifies the author of the comment being answered", () => {
    expect(
      recipientsFor(comment("Agreed", "parent"), { actorId: "sam", parentAuthorId: "riley" }),
    ).toEqual([{ userId: "riley", kind: "replied" }]);
  });

  it("says nothing when you reply to yourself", () => {
    expect(
      recipientsFor(comment("One more thing", "parent"), {
        actorId: "sam",
        parentAuthorId: "sam",
      }),
    ).toEqual([]);
  });

  // A comment outlives its author's account, so the parent may have none.
  it("copes with a parent whose author has left", () => {
    expect(
      recipientsFor(comment("Agreed", "parent"), { actorId: "sam", parentAuthorId: null }),
    ).toEqual([]);
  });

  /**
   * One event, one notification. Being both named and answered in the same
   * comment is a single thing that happened, and the mention is the more
   * specific description of it.
   */
  it("notifies someone named in the reply that answers them only once", () => {
    expect(
      recipientsFor(comment("@Riley Kaur good point", "parent"), {
        actorId: "sam",
        parentAuthorId: "riley",
      }),
    ).toEqual([{ userId: "riley", kind: "mentioned" }]);
  });
});

describe("editing", () => {
  it("notifies only the mention an edit added", () => {
    const op: Operation = {
      kind: "editComment",
      commentId: "c1",
      taskId: "t1",
      from: doc("@Riley Kaur look at this"),
      to: doc("@Riley Kaur and @Avery Mills look at this"),
    };
    expect(recipientsFor(op, { actorId: "sam" })).toEqual([
      { userId: "avery", kind: "mentioned" },
    ]);
  });

  it("notifies nobody when an edit changes no mentions", () => {
    const op: Operation = {
      kind: "editComment",
      commentId: "c1",
      taskId: "t1",
      from: doc("@Riley Kaur look"),
      to: doc("@Riley Kaur look here"),
    };
    expect(recipientsFor(op, { actorId: "sam" })).toEqual([]);
  });
});

describe("a description", () => {
  it("notifies the people it names", () => {
    const op: Operation = {
      kind: "setDescription",
      taskId: "t1",
      from: null,
      to: doc("Owner is @Riley Kaur"),
    };
    expect(recipientsFor(op, { actorId: "sam" })).toEqual([
      { userId: "riley", kind: "mentioned" },
    ]);
  });

  /**
   * A description is saved repeatedly while it is being written and every save
   * carries every mention in it. Without the previous set, adding a sentence
   * notifies everyone already named all over again.
   */
  it("does not notify someone it already named", () => {
    const op: Operation = {
      kind: "setDescription",
      taskId: "t1",
      from: doc("Owner is @Riley Kaur"),
      to: doc("Owner is @Riley Kaur. Reviewer is @Avery Mills"),
    };
    expect(
      recipientsFor(op, { actorId: "sam", previouslyMentioned: ["riley"] }),
    ).toEqual([{ userId: "avery", kind: "mentioned" }]);
  });

  it("notifies nobody when the description is cleared", () => {
    const op: Operation = {
      kind: "setDescription",
      taskId: "t1",
      from: doc("Owner is @Riley Kaur"),
      to: null,
    };
    expect(recipientsFor(op, { actorId: "sam", previouslyMentioned: ["riley"] })).toEqual([]);
  });
});

describe("everything else is ambient", () => {
  it.each<Operation>([
    { kind: "setField", taskId: "t1", field: "statusId", from: "a", to: "b" },
    { kind: "setField", taskId: "t1", field: "dueAt", from: null, to: "2026-01-01" },
    { kind: "setCustomField", taskId: "t1", fieldId: "f1", from: 1, to: 2 },
    { kind: "archiveTask", taskId: "t1" },
    { kind: "deleteComment", commentId: "c1", taskId: "t1" },
  ])("writes no row for $kind", (op) => {
    expect(recipientsFor(op, { actorId: "sam", parentAuthorId: "riley" })).toEqual([]);
  });
});
