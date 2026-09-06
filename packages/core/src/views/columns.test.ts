import { describe, expect, it } from "vitest";

import { type FieldDefinition, indexFields } from "../fields";
import { BUILTIN_SQL, ViewCompileError, compileViewQuery } from "./compile";
import {
  BUILTIN_COLUMNS,
  availableColumns,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  resolveColumns,
  validateColumns,
} from "./columns";
import { DEFAULT_VIEW_DEFINITION } from "./types";

const NUMBER_FIELD = "44444444-4444-4444-8444-444444444444";
const DROPDOWN_FIELD = "55555555-5555-4555-8555-555555555555";
const LABELS_FIELD = "66666666-6666-4666-8666-666666666666";
const OPTION = "77777777-7777-4777-8777-777777777777";
const MISSING_FIELD = "88888888-8888-4888-8888-888888888888";

const catalog = indexFields([
  { id: NUMBER_FIELD, type: "number", typeConfig: {} },
  {
    id: DROPDOWN_FIELD,
    type: "drop_down",
    typeConfig: { options: [{ id: OPTION, name: "S1", color: "#EC5B5B", orderindex: 0 }] },
  },
  {
    id: LABELS_FIELD,
    type: "labels",
    typeConfig: { options: [{ id: OPTION, name: "API", color: "#5B8DEF", orderindex: 0 }] },
  },
] as FieldDefinition[]);

const names = new Map([
  [NUMBER_FIELD, "Story Points"],
  [DROPDOWN_FIELD, "Severity"],
  [LABELS_FIELD, "Components"],
]);

describe("resolving columns", () => {
  it("resolves the default view definition's columns", () => {
    const { columns, dropped } = resolveColumns(DEFAULT_VIEW_DEFINITION.columns);
    expect(dropped).toEqual([]);
    expect(columns.map((c) => c.ref)).toEqual([
      "status",
      "name",
      "assignee",
      "priority",
      "dueAt",
    ]);
  });

  it("takes a custom column's label from the field's name, not its type", () => {
    const { columns } = resolveColumns([{ field: `cf:${NUMBER_FIELD}` }], catalog, names);
    expect(columns[0]?.label).toBe("Story Points");
    expect(columns[0]?.custom).toBe(true);
    expect(columns[0]?.fieldId).toBe(NUMBER_FIELD);
  });

  it("falls back to the type's label when the field has no name", () => {
    const { columns } = resolveColumns([{ field: `cf:${NUMBER_FIELD}` }], catalog);
    expect(columns[0]?.label).toBe("Number");
  });

  it("carries a dropdown's options so a cell can colour the value", () => {
    const { columns } = resolveColumns([{ field: `cf:${DROPDOWN_FIELD}` }], catalog, names);
    expect(columns[0]?.kind).toBe("choice");
    expect(columns[0]?.options?.[0]?.name).toBe("S1");
  });

  it("right-aligns numbers and left-aligns everything else", () => {
    const { columns } = resolveColumns(
      [{ field: "name" }, { field: "points" }, { field: `cf:${NUMBER_FIELD}` }],
      catalog,
    );
    expect(columns.map((c) => c.align)).toEqual(["left", "right", "right"]);
  });

  it("marks multi-value columns unsortable, because the compiler refuses to order by a set", () => {
    const { columns } = resolveColumns(
      [{ field: "assignee" }, { field: "tag" }, { field: `cf:${LABELS_FIELD}` }, { field: "dueAt" }],
      catalog,
    );
    expect(columns.map((c) => c.sortable)).toEqual([false, false, false, true]);
  });

  it("drops hidden columns without reporting them as broken", () => {
    const { columns, dropped } = resolveColumns([
      { field: "name" },
      { field: "priority", hidden: true },
    ]);
    expect(columns.map((c) => c.ref)).toEqual(["name"]);
    expect(dropped).toEqual([]);
  });

  it("clamps a stored width into something a table can render", () => {
    const { columns } = resolveColumns([
      { field: "name", width: 4 },
      { field: "status", width: 99999 },
      { field: "priority", width: 120 },
    ]);
    expect(columns.map((c) => c.width)).toEqual([MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, 120]);
  });

  it("does not offer position, which is an opaque ordering key (ADR 2)", () => {
    expect(BUILTIN_COLUMNS.position).toBeUndefined();
    const { columns, dropped } = resolveColumns([{ field: "position" }]);
    expect(columns).toEqual([]);
    expect(dropped).toEqual(["position"]);
  });
});

describe("a column that names nothing", () => {
  // The asymmetry this module exists for: one deleted field must not take
  // every view that mentioned it off the air, but it must not be saveable.
  it("is dropped on read, keeping the rest of the view alive", () => {
    const { columns, dropped } = resolveColumns(
      [{ field: "name" }, { field: `cf:${MISSING_FIELD}` }, { field: "dueAt" }],
      catalog,
      names,
    );
    expect(columns.map((c) => c.ref)).toEqual(["name", "dueAt"]);
    expect(dropped).toEqual([`cf:${MISSING_FIELD}`]);
  });

  it("is refused on write", () => {
    expect(() => validateColumns([{ field: `cf:${MISSING_FIELD}` }], catalog)).toThrow(
      ViewCompileError,
    );
    expect(() => validateColumns([{ field: "nonsense" as never }])).toThrow(/unknown field/i);
  });

  it("is refused on write even when hidden, so un-hiding it later cannot fail", () => {
    expect(() =>
      validateColumns([{ field: `cf:${MISSING_FIELD}`, hidden: true }], catalog),
    ).toThrow(ViewCompileError);
  });

  it("passes validation when the catalog has it", () => {
    expect(() =>
      validateColumns([{ field: "name" }, { field: `cf:${LABELS_FIELD}` }], catalog),
    ).not.toThrow();
  });
});

describe("the SELECT list and the column table", () => {
  const compiled = compileViewQuery({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    viewerId: "22222222-2222-4222-8222-222222222222",
    scope: { kind: "everything" },
    definition: DEFAULT_VIEW_DEFINITION,
  });
  const selectList = compiled.text.slice(0, compiled.text.indexOf("FROM tasks t"));

  // The drift this guards against is silent: a column offered in the header
  // whose value never arrives renders as an empty cell for every row, which
  // reads as "no data" rather than "this was never selected".
  it("returns every single-valued built-in a column may name", () => {
    for (const [ref, meta] of Object.entries(BUILTIN_COLUMNS)) {
      // Multi-valued fields live in child tables and are loaded per page
      // alongside the rows, not projected onto them.
      if (meta.kind === "users" || meta.kind === "tags") continue;
      expect(selectList, `no column for ${ref}`).toContain(
        BUILTIN_SQL[ref as keyof typeof BUILTIN_SQL],
      );
    }
  });
});

describe("what a cell needs to format a value", () => {
  it("carries the field's own config, so formatting has one source", () => {
    const catalogWithConfig = indexFields([
      { id: NUMBER_FIELD, type: "currency", typeConfig: { code: "GBP", precision: 2 } },
    ] as FieldDefinition[]);

    const { columns } = resolveColumns([{ field: `cf:${NUMBER_FIELD}` }], catalogWithConfig);
    expect(columns[0]?.kind).toBe("currency");
    expect(columns[0]?.config).toEqual({ code: "GBP", precision: 2 });
  });
});

describe("what a column chooser may offer", () => {
  it("never offers a column that saving would refuse", () => {
    // The contract that makes the menu trustworthy, mirroring the filter bar's.
    for (const option of availableColumns(catalog, new Set(), names)) {
      expect(() => validateColumns([{ field: option.ref }], catalog)).not.toThrow();
    }
  });

  it("offers built-ins and custom fields together, custom flagged", () => {
    const options = availableColumns(catalog, new Set(), names);
    expect(options.filter((o) => o.custom).map((o) => o.label)).toEqual([
      "Story Points",
      "Severity",
      "Components",
    ]);
    expect(options.find((o) => o.ref === "dueAt")?.label).toBe("Due date");
  });

  it("hides archived fields from the menu but keeps them resolvable", () => {
    const options = availableColumns(catalog, new Set([LABELS_FIELD]), names);
    expect(options.some((o) => o.ref === `cf:${LABELS_FIELD}`)).toBe(false);
    // A view already showing it keeps working.
    const { columns } = resolveColumns([{ field: `cf:${LABELS_FIELD}` }], catalog, names);
    expect(columns).toHaveLength(1);
  });

  it("does not offer position", () => {
    expect(availableColumns().some((o) => o.ref === "position")).toBe(false);
  });
});
