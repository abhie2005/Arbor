import { describe, expect, it } from "vitest";

import { FieldError, type FieldDefinition, indexFields } from "../fields";
import {
  BUILTIN_FILTERABLE,
  filterableFields,
  opNeedsValue,
  operatorLabel,
  operatorsFor,
} from "./filterable";
import type { BuiltinField } from "./types";

const NUMBER_FIELD = "44444444-4444-4444-8444-444444444444";
const LABELS_FIELD = "66666666-6666-4666-8666-666666666666";
const OPTION = "77777777-7777-4777-8777-777777777777";

const catalog = indexFields([
  { id: NUMBER_FIELD, type: "number", typeConfig: {} },
  {
    id: LABELS_FIELD,
    type: "labels",
    typeConfig: { options: [{ id: OPTION, name: "infra", color: "#43B581", orderindex: 0 }] },
  },
] as FieldDefinition[]);

describe("what a filter bar may offer", () => {
  it("never offers an operator the compiler would reject", () => {
    // The contract that makes the menu trustworthy: everything offered is
    // something the server will accept.
    for (const [ref, meta] of Object.entries(BUILTIN_FILTERABLE)) {
      expect(operatorsFor(ref as BuiltinField)).toEqual(meta.ops);
    }
  });

  it("takes a custom field's operators from its declared type", () => {
    expect(operatorsFor(`cf:${NUMBER_FIELD}`, catalog)).toContain("gt");
    // A set of labels has no ordering, so no ordering operators.
    expect(operatorsFor(`cf:${LABELS_FIELD}`, catalog)).not.toContain("gt");
  });

  it("refuses a custom field the catalog does not have", () => {
    expect(() => operatorsFor(`cf:${NUMBER_FIELD}`)).toThrow(FieldError);
  });

  it("does not offer position, which is an ordering implementation detail", () => {
    expect(BUILTIN_FILTERABLE.position).toBeUndefined();
    expect(() => operatorsFor("position")).toThrow(/cannot be filtered/);
  });

  it("lists built-ins and custom fields together, custom flagged", () => {
    const fields = filterableFields(catalog);
    const custom = fields.filter((f) => f.custom);
    expect(custom).toHaveLength(2);
    expect(fields.find((f) => f.ref === "status")?.input).toBe("status");
  });

  it("hides archived custom fields from the menu but keeps them filterable", () => {
    const fields = filterableFields(catalog, new Set([LABELS_FIELD]));
    expect(fields.some((f) => f.ref === `cf:${LABELS_FIELD}`)).toBe(false);
    // Still resolvable, because a saved view may already reference it.
    expect(operatorsFor(`cf:${LABELS_FIELD}`, catalog)).toBeDefined();
  });

  it("prefers the field's real name over its type label", () => {
    const named = filterableFields(catalog, new Set(), new Map([[NUMBER_FIELD, "Story Points"]]));
    expect(named.find((f) => f.ref === `cf:${NUMBER_FIELD}`)?.label).toBe("Story Points");
  });

  it("carries a choice field's own options as its value list", () => {
    const fields = filterableFields(catalog);
    const labels = fields.find((f) => f.ref === `cf:${LABELS_FIELD}`);
    // Without this the UI offers a text box whose only valid input is an
    // option's uuid — which nobody knows and nobody should have to type.
    expect(labels?.input).toBe("choice");
    expect(labels?.options).toEqual([{ id: OPTION, name: "infra" }]);
  });

  it("gives non-choice fields no options list", () => {
    const number = filterableFields(catalog).find((f) => f.ref === `cf:${NUMBER_FIELD}`);
    expect(number?.input).toBe("number");
    expect(number?.options).toBeUndefined();
  });

  it("picks a control from the type, not from the storage column", () => {
    // Status and assignee are both uuids in SQL and need different pickers.
    const fields = filterableFields(catalog);
    expect(fields.find((f) => f.ref === "assignee")?.input).toBe("user");
    expect(fields.find((f) => f.ref === "status")?.input).toBe("status");
  });
});

describe("operator wording", () => {
  it("says 'is after' for dates and 'is more than' for numbers", () => {
    expect(operatorLabel("gt", "date")).toBe("is after");
    expect(operatorLabel("gt", "number")).toBe("is more than");
  });

  it("hides the value control for presence checks", () => {
    expect(opNeedsValue("isNull")).toBe(false);
    expect(opNeedsValue("eq")).toBe(true);
  });
});
