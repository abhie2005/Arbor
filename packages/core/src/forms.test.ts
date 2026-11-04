import { describe, expect, it } from "vitest";

import { FormError, parseFormDefinition, parseSubmission } from "./forms";

const nameOnly = parseFormDefinition({ fields: [{ field: "name", label: "What do you need?" }] });

describe("parseFormDefinition", () => {
  it("keeps the declared label and falls back to the field's own", () => {
    const parsed = parseFormDefinition({
      fields: [{ field: "name", label: "  What do you need?  " }, { field: "priority", label: "" }],
    });
    expect(parsed.fields[0]?.label).toBe("What do you need?");
    expect(parsed.fields[1]?.label).toBe("Priority");
  });

  it("refuses a field a form may not ask for, by name", () => {
    expect(() => parseFormDefinition({ fields: [{ field: "statusId" }] })).toThrow(FormError);
    expect(() => parseFormDefinition({ fields: [{ field: "homeListId" }] })).toThrow(
      /may not ask for/,
    );
  });

  it("refuses the same field twice, because the second write would win silently", () => {
    expect(() =>
      parseFormDefinition({ fields: [{ field: "name" }, { field: "name" }] }),
    ).toThrow(/twice/);
  });

  it("insists on a name, and makes it required whatever the declaration says", () => {
    expect(() => parseFormDefinition({ fields: [{ field: "priority" }] })).toThrow(/must ask/);
    const parsed = parseFormDefinition({ fields: [{ field: "name", required: false }] });
    expect(parsed.fields[0]?.required).toBe(true);
  });

  it("refuses a definition that is not one", () => {
    expect(() => parseFormDefinition(null)).toThrow(FormError);
    expect(() => parseFormDefinition({ fields: {} })).toThrow(FormError);
    expect(() => parseFormDefinition({ fields: [] })).toThrow(/asks nothing/);
  });
});

describe("parseSubmission", () => {
  it("takes the fields the form asked for", () => {
    const form = parseFormDefinition({
      fields: [{ field: "name" }, { field: "priority" }, { field: "dueAt" }],
    });
    expect(parseSubmission(form, { name: "A broken sink", priority: "2", dueAt: "2026-03-04" })).toEqual({
      name: "A broken sink",
      priority: 2,
      dueAt: "2026-03-04T00:00:00.000Z",
    });
  });

  /**
   * The check this module exists for. An undeclared key is refused rather than
   * dropped: a form is the only unauthenticated writer in the codebase, and
   * "quietly ignored" and "accepted" look identical from outside.
   */
  it("refuses a field the form did not ask for rather than ignoring it", () => {
    expect(() => parseSubmission(nameOnly, { name: "Fine", statusId: "whatever" })).toThrow(
      /does not ask for statusId/,
    );
    expect(() => parseSubmission(nameOnly, { name: "Fine", homeListId: "elsewhere" })).toThrow(
      FormError,
    );
  });

  it("refuses a missing required answer, and allows a missing optional one", () => {
    const form = parseFormDefinition({
      fields: [{ field: "name" }, { field: "priority", required: true }, { field: "points" }],
    });
    expect(() => parseSubmission(form, { name: "x" })).toThrow(/Priority is required/);
    expect(parseSubmission(form, { name: "x", priority: 1 })).toEqual({ name: "x", priority: 1 });
  });

  it("treats blank as absent, so an untouched optional control is not a value", () => {
    const form = parseFormDefinition({ fields: [{ field: "name" }, { field: "dueAt" }] });
    expect(parseSubmission(form, { name: "x", dueAt: "" })).toEqual({ name: "x" });
  });

  it("refuses an empty name even when the key is there", () => {
    expect(() => parseSubmission(nameOnly, { name: "   " })).toThrow(/required/);
  });

  it("coerces what a form posts, because every answer arrives as a string", () => {
    const form = parseFormDefinition({ fields: [{ field: "name" }, { field: "points" }] });
    expect(parseSubmission(form, { name: "x", points: "3.5" })).toEqual({ name: "x", points: 3.5 });
  });

  it("refuses a number that is not one, and a priority outside the scale", () => {
    const form = parseFormDefinition({
      fields: [{ field: "name" }, { field: "priority" }, { field: "points" }],
    });
    expect(() => parseSubmission(form, { name: "x", priority: "9" })).toThrow(/between 1 and 4/);
    expect(() => parseSubmission(form, { name: "x", points: "lots" })).toThrow(/must be a number/);
  });

  /**
   * Invariant 9: a date-only value is midnight **UTC**. A browser's local
   * midnight would make the same answer mean a different day either side of a
   * timezone, which is D-121 and D-132's bug arriving through a new door.
   */
  it("reads a date as a calendar day at midnight UTC", () => {
    const form = parseFormDefinition({ fields: [{ field: "name" }, { field: "dueAt" }] });
    expect(parseSubmission(form, { name: "x", dueAt: "2026-12-25" })).toEqual({
      name: "x",
      dueAt: "2026-12-25T00:00:00.000Z",
    });
    expect(() => parseSubmission(form, { name: "x", dueAt: "25/12/2026" })).toThrow(/must be a date/);
    expect(() => parseSubmission(form, { name: "x", dueAt: "2026-02-31" })).toThrow(FormError);
  });

  it("refuses a body that is not a set of answers", () => {
    expect(() => parseSubmission(nameOnly, "name=x")).toThrow(FormError);
    expect(() => parseSubmission(nameOnly, ["x"])).toThrow(FormError);
  });
});
