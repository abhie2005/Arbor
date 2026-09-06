import { describe, expect, it } from "vitest";

import { FilterUrlError, decodeFilters, encodeFilters } from "./url";
import { DEFAULT_VIEW_DEFINITION, type FilterGroup } from "./types";

const base: FilterGroup = DEFAULT_VIEW_DEFINITION.filters;

describe("filters in the URL", () => {
  it("omits the parameter entirely when there is nothing to say", () => {
    expect(encodeFilters(base)).toBeNull();
  });

  it("round-trips conditions", () => {
    const filters: FilterGroup = {
      ...base,
      conditions: [
        { field: "priority", op: "lte", value: 2 },
        { field: "assignee", op: "isNull" },
      ],
    };

    const encoded = encodeFilters(filters);
    expect(encoded).not.toBeNull();
    const decoded = decodeFilters(encoded, base);

    expect(decoded.conditions).toEqual(filters.conditions);
  });

  it("keeps a value-less operator to two elements", () => {
    const encoded = encodeFilters({ ...base, conditions: [{ field: "dueAt", op: "isNotNull" }] });
    expect(encoded).toContain('["dueAt","isNotNull"]');
  });

  it("carries the combinator and showClosed only when not the default", () => {
    expect(encodeFilters({ ...base, op: "OR", conditions: [] })).toContain("OR");
    expect(encodeFilters({ ...base, showClosed: true, conditions: [] })).toContain("closed");
    expect(encodeFilters({ ...base, op: "AND", conditions: [] })).toBeNull();
  });

  it("returns the base filters when the parameter is absent", () => {
    expect(decodeFilters(null, base)).toEqual(base);
    expect(decodeFilters("", base)).toEqual(base);
  });

  it("rejects a malformed link rather than showing everything", () => {
    // Silently dropping a bad filter would render an unfiltered view that looks
    // like a filtered one — the same failure shape as D-042.
    expect(() => decodeFilters("not json", base)).toThrow(FilterUrlError);
    expect(() => decodeFilters('{"c":"nope"}', base)).toThrow(/must be an array/);
    expect(() => decodeFilters('{"c":[["dueAt"]]}', base)).toThrow(/triple/);
    expect(() => decodeFilters('{"c":[["dueAt","sideways",1]]}', base)).toThrow(/unknown operator/);
    expect(() => decodeFilters('{"op":"XOR"}', base)).toThrow(/combinator/);
  });

  it("caps how many filters a link may carry", () => {
    const many = JSON.stringify({
      c: Array.from({ length: 26 }, () => ["priority", "eq", 1]),
    });
    expect(() => decodeFilters(many, base)).toThrow(/at most 25/);
  });

  it("passes an unknown field through for the compiler to reject", () => {
    // Not this module's job — the compiler resolves fields through a closed map
    // and duplicating that list here would give it two places to drift.
    const decoded = decodeFilters('{"c":[["nonsense","eq",1]]}', base);
    expect(decoded.conditions[0]?.field).toBe("nonsense");
  });

  it("preserves the base's subtask and archive settings", () => {
    const decoded = decodeFilters('{"c":[["priority","eq",1]]}', {
      ...base,
      showSubtasks: 3,
      includeArchived: true,
    });
    expect(decoded.showSubtasks).toBe(3);
    expect(decoded.includeArchived).toBe(true);
  });
});
