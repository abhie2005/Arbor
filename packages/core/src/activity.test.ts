import { describe, expect, it } from "vitest";

import { type ActivityChange, sentenceList, summarizeAmbient, summarizeChanges } from "./activity";

const change = (verb: string, field: string | null = null): ActivityChange => ({ verb, field });

describe("naming people", () => {
  it("joins two with 'and'", () => {
    expect(sentenceList(["Riley Kaur", "Sam Petrov"])).toBe("Riley Kaur and Sam Petrov");
  });

  it("counts the tail rather than listing everyone", () => {
    expect(sentenceList(["A", "B", "C", "D", "E"])).toBe("A, B, C and 2 others");
  });

  it("keeps 'other' singular for one", () => {
    expect(sentenceList(["A", "B", "C", "D"])).toBe("A, B, C and 1 other");
  });
});

describe("what happened", () => {
  it("collapses field changes into one clause", () => {
    expect(summarizeChanges([change("task.status_id_changed", "status_id"), change("task.due_at_changed", "due_at")], 2)).toBe(
      "changed status and due date",
    );
  });

  it("names a repeated field once", () => {
    const changes = [change("task.status_id_changed", "status_id"), change("task.status_id_changed", "status_id")];
    expect(summarizeChanges(changes, 2)).toBe("changed status");
  });

  it("gives a verb its own phrase rather than folding it into 'changed'", () => {
    expect(summarizeChanges([change("comment.added")], 1)).toBe("commented");
  });

  // The log records a comment's *id* in `field`, because that is what its
  // inverse needs. Reading the field without asking the verb first put a uuid
  // in front of people.
  it("never reads a field the verb has already explained", () => {
    expect(summarizeChanges([change("comment.added", "3f0c-not-a-column")], 1)).toBe("commented");
  });

  it("puts the phrases first and the fields last", () => {
    const changes = [change("task.status_id_changed", "status_id"), change("comment.added")];
    expect(summarizeChanges(changes, 2)).toBe("commented and changed status");
  });

  it("collapses adding and removing an assignee into one thing that happened", () => {
    const changes = [change("task.assignee_added"), change("task.assignee_removed")];
    expect(summarizeChanges(changes, 2)).toBe("changed assignees");
  });

  // Two clauses that both start with "changed" read as a list that forgot it
  // was one: "changed a custom field and changed type".
  it("folds a named thing into the clause rather than repeating the verb", () => {
    const changes = [
      change("task.custom_field_changed", "0d6f-a-field-id"),
      change("task.task_type_id_changed", "task_type_id"),
    ];
    expect(summarizeChanges(changes, 2)).toBe("changed a custom field and type");
  });

  // The sample the query takes is of distinct kinds, so the count can exceed
  // what is named. Naming three fields is a glance; the task holds the rest.
  it("counts the tail of a long field list", () => {
    const changes = [
      change("task.status_id_changed", "status_id"),
      change("task.due_at_changed", "due_at"),
      change("task.priority_changed", "priority"),
      change("task.points_changed", "points"),
      change("task.start_at_changed", "start_at"),
    ];
    expect(summarizeChanges(changes, 5)).toBe("changed status, due date, priority and 2 others");
  });

  it("falls back to the count when nothing can be named", () => {
    expect(summarizeChanges([change("task.mystery_happened")], 4)).toBe("made 4 changes");
  });

  it("keeps 'change' singular for one", () => {
    expect(summarizeChanges([], 1)).toBe("made 1 change");
  });

  // An unknown column is still a column: better its own name than "a field".
  it("uses a field's own name when there is no label for it", () => {
    expect(summarizeChanges([change("task.mystery_changed", "mystery")], 1)).toBe("changed mystery");
  });
});

describe("the whole line", () => {
  it("reads as a sentence about people, not about the task", () => {
    expect(
      summarizeAmbient({
        actors: ["Riley Kaur"],
        changes: [change("task.status_id_changed", "status_id")],
        total: 1,
      }),
    ).toBe("Riley Kaur changed status");
  });

  it("survives an actor the log could not name", () => {
    expect(summarizeAmbient({ actors: [], changes: [change("comment.added")], total: 1 })).toBe(
      "Someone commented",
    );
  });
});
