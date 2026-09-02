import { describe, expect, it } from "vitest";

import {
  FIELD_TYPES,
  FIELD_TYPE_META,
  FieldError,
  type FieldDefinition,
  type FieldPlacement,
  fieldSupportsOp,
  fieldsForContainer,
  fieldsForTaskType,
  fieldValueColumn,
  parseFieldConfig,
  parseFieldValue,
  parseFilterValue,
} from "./fields";

const OPTION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPTION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function field<T extends Parameters<typeof parseFieldConfig>[0]>(
  type: T,
  rawConfig: unknown = {},
): FieldDefinition {
  return {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    type,
    typeConfig: parseFieldConfig(type, rawConfig),
  } as FieldDefinition;
}

const dropdown = () =>
  field("drop_down", {
    options: [
      { id: OPTION_A, name: "S1", color: "#EC5B5B", orderindex: 0 },
      { id: OPTION_B, name: "S2", color: "#E9A23B", orderindex: 1 },
    ],
  });

describe("field type metadata", () => {
  it("describes every type in the database enum", () => {
    for (const type of FIELD_TYPES) {
      expect(FIELD_TYPE_META[type]).toBeDefined();
    }
    expect(Object.keys(FIELD_TYPE_META)).toHaveLength(FIELD_TYPES.length);
  });

  it("routes each type to the column its values are indexed in", () => {
    expect(fieldValueColumn(field("number"))).toBe("value_num");
    expect(fieldValueColumn(field("short_text"))).toBe("value_text");
    expect(fieldValueColumn(field("checkbox"))).toBe("value_bool");
    expect(fieldValueColumn(field("date"))).toBe("value_date");
    expect(fieldValueColumn(field("labels", { options: [{ id: OPTION_A, name: "x" }] }))).toBe(
      "value_json",
    );
  });

  it("resolves a derived field's column from its declared result type", () => {
    const asDate = field("formula", { expression: "due - start", resultType: "date" });
    const asNumber = field("formula", { expression: "1 + 1" });
    // A formula returning a date must sort as a date; sorting it as text puts
    // 2026-01-02 before 2025-12-31.
    expect(fieldValueColumn(asDate)).toBe("value_date");
    expect(fieldValueColumn(asNumber)).toBe("value_num");
  });

  it("allows ordering operators only where ordering means something", () => {
    expect(fieldSupportsOp("number", "gt")).toBe(true);
    expect(fieldSupportsOp("drop_down", "gt")).toBe(false);
    expect(fieldSupportsOp("location", "eq")).toBe(false);
    expect(fieldSupportsOp("location", "isNull")).toBe(true);
  });
});

describe("parseFieldConfig", () => {
  it("drops keys it does not recognize instead of persisting them", () => {
    const config = parseFieldConfig("rating", { max: 4, injected: "keep me" });
    expect(config).toEqual({ max: 4 });
  });

  it("defaults rather than failing where a default is obvious", () => {
    expect(parseFieldConfig("rating", {})).toEqual({ max: 5 });
    expect(parseFieldConfig("currency", {})).toEqual({ code: "USD", precision: 2 });
    expect(parseFieldConfig("date", {})).toEqual({ includeTime: false });
  });

  it("rejects a choice field with no options", () => {
    expect(() => parseFieldConfig("drop_down", { options: [] })).toThrow(FieldError);
  });

  it("rejects duplicate option names, which are indistinguishable in a menu", () => {
    expect(() =>
      parseFieldConfig("drop_down", {
        options: [
          { id: OPTION_A, name: "S1" },
          { id: OPTION_B, name: "s1" },
        ],
      }),
    ).toThrow(/Duplicate option name/);
  });

  it("requires option ids to be uuids, never names", () => {
    expect(() => parseFieldConfig("drop_down", { options: [{ id: "S1", name: "S1" }] })).toThrow(
      FieldError,
    );
  });

  it("sorts options by orderindex so callers never have to", () => {
    const config = parseFieldConfig("labels", {
      options: [
        { id: OPTION_A, name: "second", orderindex: 5 },
        { id: OPTION_B, name: "first", orderindex: 1 },
      ],
    });
    expect(config.options.map((o) => o.name)).toEqual(["first", "second"]);
  });

  it("rejects a currency code that is not ISO 4217 shaped", () => {
    expect(() => parseFieldConfig("currency", { code: "dollars" })).toThrow(/ISO 4217/);
    expect(parseFieldConfig("currency", { code: "eur" })).toEqual({ code: "EUR", precision: 2 });
  });

  it("rejects a progress range that cannot contain a value", () => {
    expect(() => parseFieldConfig("manual_progress", { start: 10, end: 10 })).toThrow(FieldError);
  });

  it("rejects a formula with no expression", () => {
    expect(() => parseFieldConfig("formula", { resultType: "number" })).toThrow(FieldError);
  });
});

describe("parseFieldValue", () => {
  it("treats an empty value as clearing the field, for every type", () => {
    expect(parseFieldValue(field("number"), null)).toBeNull();
    expect(parseFieldValue(dropdown(), "")).toBeNull();
  });

  it("accepts an option id and refuses anything else", () => {
    expect(parseFieldValue(dropdown(), OPTION_A)).toBe(OPTION_A);
    // The name is not the value — renaming an option must not detach tasks.
    expect(() => parseFieldValue(dropdown(), "S1")).toThrow(FieldError);
  });

  it("keeps a rating inside its configured scale", () => {
    const rating = field("rating", { max: 3 });
    expect(parseFieldValue(rating, 3)).toBe(3);
    expect(() => parseFieldValue(rating, 4)).toThrow(/between 0 and 3/);
    expect(() => parseFieldValue(rating, 1.5)).toThrow(FieldError);
  });

  it("refuses a URL that is not http or https", () => {
    expect(parseFieldValue(field("url"), "https://example.com/x")).toBe("https://example.com/x");
    expect(() => parseFieldValue(field("url"), "javascript:alert(1)")).toThrow(/http and https/);
  });

  it("normalizes a multi-value field to a deduplicated array", () => {
    const people = field("users", { multiple: true });
    expect(parseFieldValue(people, [USER, USER])).toEqual([USER]);
  });

  it("enforces single-select on a multi-value type configured as single", () => {
    const single = field("users", { multiple: false });
    expect(() => parseFieldValue(single, [USER, OPTION_A])).toThrow(/single value/);
  });

  it("bounds a location to real coordinates", () => {
    expect(parseFieldValue(field("location"), { lat: 37.7, lng: -122.4 })).toEqual({
      lat: 37.7,
      lng: -122.4,
      label: null,
    });
    expect(() => parseFieldValue(field("location"), { lat: 120, lng: 0 })).toThrow(/Latitude/);
  });

  it("refuses to let a user write a computed field", () => {
    const formula = field("formula", { expression: "1 + 1" });
    expect(() => parseFieldValue(formula, 2)).toThrow(/computed by the system/);
  });
});

describe("parseFilterValue — the API boundary D-013 was missing", () => {
  it("rejects a number filter against a text field instead of matching nothing", () => {
    // The exact bug: this used to compile to `value_num = 3` on a field whose
    // values live in value_text, and return an empty view with no error.
    expect(() => parseFilterValue(field("short_text"), "eq", 3)).toThrow(FieldError);
  });

  it("rejects an operator the type has no meaning for", () => {
    expect(() => parseFilterValue(dropdown(), "gt", OPTION_A)).toThrow(/does not apply/);
    expect(() => parseFilterValue(field("location"), "eq", "x")).toThrow(/does not apply/);
  });

  it("passes presence checks through without a value", () => {
    expect(parseFilterValue(field("number"), "isNull", undefined)).toBeUndefined();
    expect(parseFilterValue(field("number"), "isNotNull", "ignored")).toBeUndefined();
  });

  it("validates every element of an `in` list, not just the first", () => {
    expect(parseFilterValue(dropdown(), "in", [OPTION_A, OPTION_B])).toEqual([OPTION_A, OPTION_B]);
    expect(() => parseFilterValue(dropdown(), "in", [OPTION_A, "nope"])).toThrow(FieldError);
  });

  it("requires `between` to carry exactly two bounds", () => {
    expect(parseFilterValue(field("number"), "between", [1, 5])).toEqual([1, 5]);
    expect(() => parseFilterValue(field("number"), "between", [1])).toThrow(/two-element/);
  });

  it("compares a multi-value field against one member, not the whole set", () => {
    const people = field("users");
    expect(parseFilterValue(people, "eq", USER)).toBe(USER);
    expect(() => parseFilterValue(people, "eq", "not-a-uuid")).toThrow(FieldError);
  });

  it("coerces a date filter to a Date so it reaches value_date correctly", () => {
    const value = parseFilterValue(field("date"), "gte", "2026-09-02T00:00:00.000Z");
    expect(value).toBeInstanceOf(Date);
  });

  it("allows filtering a computed field even though writing one is refused", () => {
    const formula = field("formula", { expression: "1 + 1" });
    expect(parseFilterValue(formula, "gt", 10)).toBe(10);
  });
});

describe("field placement", () => {
  const containers = new Map([
    ["space", { id: "space", parentId: null }],
    ["folder", { id: "folder", parentId: "space" }],
    ["list", { id: "list", parentId: "folder" }],
    ["other", { id: "other", parentId: null }],
  ]);

  function placed(
    id: string,
    containerId: string | null,
    position: number,
    scopes: string[] = [],
    archived = false,
  ): FieldPlacement {
    return {
      id,
      name: id,
      type: "number",
      typeConfig: {},
      containerId,
      position,
      scopeTaskTypeIds: scopes,
      archived,
    };
  }

  const all = [
    placed("local", "list", 0),
    placed("workspace-wide", null, 0),
    placed("space-level", "space", 1),
    placed("elsewhere", "other", 0),
    placed("retired", "space", 2, [], true),
  ];

  it("accumulates down the tree instead of overriding", () => {
    const available = fieldsForContainer("list", containers, all);
    // A local field adds to the space's fields; it does not replace them.
    expect(available.map((f) => f.id)).toEqual(["workspace-wide", "space-level", "local"]);
  });

  it("excludes fields from a container that is not an ancestor", () => {
    const ids = fieldsForContainer("list", containers, all).map((f) => f.id);
    expect(ids).not.toContain("elsewhere");
  });

  it("excludes archived fields", () => {
    const ids = fieldsForContainer("list", containers, all).map((f) => f.id);
    expect(ids).not.toContain("retired");
  });

  it("shows a scoped field only on the types it names", () => {
    const fields = [placed("severity", "space", 0, ["bug"]), placed("points", "space", 1)];
    expect(fieldsForTaskType(fields, "bug").map((f) => f.id)).toEqual(["severity", "points"]);
    expect(fieldsForTaskType(fields, "task").map((f) => f.id)).toEqual(["points"]);
  });

  it("gives a task with no type only the unscoped fields", () => {
    const fields = [placed("severity", "space", 0, ["bug"]), placed("points", "space", 1)];
    expect(fieldsForTaskType(fields, null).map((f) => f.id)).toEqual(["points"]);
  });
});
