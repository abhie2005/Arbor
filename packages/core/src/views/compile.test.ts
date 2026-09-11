import { describe, expect, it } from "vitest";

import { type FieldDefinition, indexFields } from "../fields";
import {
  MAX_CONDITIONS,
  MAX_FILTER_DEPTH,
  ViewCompileError,
  compileAggregate,
  compileGroupCounts,
  compileViewQuery,
} from "./compile";
import { DEFAULT_VIEW_DEFINITION, type FilterGroup, type ViewDefinition } from "./types";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const VIEWER = "22222222-2222-4222-8222-222222222222";
const LIST = "33333333-3333-4333-8333-333333333333";
const FIELD = "44444444-4444-4444-8444-444444444444";
const TEXT_FIELD = "55555555-5555-4555-8555-555555555555";
const LABELS_FIELD = "66666666-6666-4666-8666-666666666666";
const OPTION = "77777777-7777-4777-8777-777777777777";

/**
 * The fields a view definition is allowed to reference. Compiling a `cf:`
 * filter without one is now an error, so every custom-field test declares what
 * it is filtering on — which is the point of the change (D-042).
 */
const CATALOG = indexFields([
  { id: FIELD, type: "number", typeConfig: {} },
  { id: TEXT_FIELD, type: "short_text", typeConfig: {} },
  {
    id: LABELS_FIELD,
    type: "labels",
    typeConfig: { options: [{ id: OPTION, name: "infra", color: "#43B581", orderindex: 0 }] },
  },
] as FieldDefinition[]);

function compile(overrides: Partial<ViewDefinition> = {}, scopeId = LIST) {
  return compileViewQuery({
    workspaceId: WORKSPACE,
    viewerId: VIEWER,
    scope: { kind: "list", id: scopeId },
    fields: CATALOG,
    definition: { ...DEFAULT_VIEW_DEFINITION, ...overrides },
  });
}

describe("compileViewQuery", () => {
  it("joins the access index before anything else", () => {
    const { text, params } = compile();
    expect(text).toContain("JOIN access_index ax ON ax.list_id = t.home_list_id");
    // The viewer is the first bound parameter, so the join is the leading predicate.
    expect(params[0]).toBe(VIEWER);
  });

  it("never inlines values", () => {
    const { text, params } = compile({
      filters: {
        op: "AND",
        conditions: [{ field: "name", op: "contains", value: "'; DROP TABLE tasks; --" }],
      },
    });
    expect(text).not.toContain("DROP TABLE");
    expect(params).toContain("%'; DROP TABLE tasks; --%");
  });

  it("rejects an unknown field rather than interpolating it", () => {
    expect(() =>
      compile({
        filters: {
          op: "AND",
          conditions: [{ field: "t.name; DROP TABLE tasks" as never, op: "eq", value: 1 }],
        },
      }),
    ).toThrow(ViewCompileError);
  });

  it("rejects a custom field reference that is not a uuid", () => {
    expect(() =>
      compile({
        filters: {
          op: "AND",
          conditions: [{ field: "cf:1); DROP TABLE tasks --" as never, op: "eq", value: 1 }],
        },
      }),
    ).toThrow(ViewCompileError);
  });

  it("hides closed tasks unless asked", () => {
    expect(compile().text).toContain("s.group IS NULL OR s.group <> 'closed'");
    expect(
      compile({ filters: { op: "AND", conditions: [], showClosed: true } }).text,
    ).not.toContain("<> 'closed'");
  });

  it("excludes archived and deleted rows by default", () => {
    const { text } = compile();
    expect(text).toContain("t.deleted_at IS NULL");
    expect(text).toContain("t.archived_at IS NULL");
  });

  it("filters a custom field through an EXISTS on the typed column", () => {
    const { text, params } = compile({
      filters: {
        op: "AND",
        conditions: [{ field: `cf:${FIELD}`, op: "gt", value: 100 }],
      },
    });
    expect(text).toContain("FROM field_values fv");
    expect(text).toContain("fv.value_num >");
    expect(params).toContain(FIELD);
    expect(params).toContain(100);
  });

  it("routes a value to the column the field's type declares", () => {
    const { text } = compile({
      filters: {
        op: "AND",
        conditions: [{ field: `cf:${TEXT_FIELD}`, op: "eq", value: "S1" }],
      },
    });
    expect(text).toContain("fv.value_text =");
  });

  it("refuses to compile a cf: reference without a catalog", () => {
    expect(() =>
      compileViewQuery({
        workspaceId: WORKSPACE,
        viewerId: VIEWER,
        scope: { kind: "list", id: LIST },
        definition: {
          ...DEFAULT_VIEW_DEFINITION,
          filters: { op: "AND", conditions: [{ field: `cf:${FIELD}`, op: "eq", value: 1 }] },
        },
      }),
    ).toThrow(/field catalog/);
  });

  it("rejects a custom field the catalog does not contain", () => {
    expect(() =>
      compile({
        filters: {
          op: "AND",
          conditions: [
            { field: "cf:99999999-9999-4999-8999-999999999999", op: "eq", value: 1 },
          ],
        },
      }),
    ).toThrow(/not in the catalog/);
  });

  it("rejects a number filter against a text field rather than matching nothing", () => {
    // The D-013 sharp edge, closed: this compiled to `value_num = 3` against a
    // field whose values live in value_text, and returned an empty view.
    expect(() =>
      compile({
        filters: {
          op: "AND",
          conditions: [{ field: `cf:${TEXT_FIELD}`, op: "eq", value: 3 }],
        },
      }),
    ).toThrow(ViewCompileError);
  });

  it("rejects an operator the field type has no meaning for", () => {
    expect(() =>
      compile({
        filters: {
          op: "AND",
          conditions: [{ field: `cf:${LABELS_FIELD}`, op: "gt", value: OPTION }],
        },
      }),
    ).toThrow(/does not apply/);
  });

  it("filters a multi-value custom field by JSONB containment", () => {
    const { text, params } = compile({
      filters: {
        op: "AND",
        conditions: [{ field: `cf:${LABELS_FIELD}`, op: "eq", value: OPTION }],
      },
    });
    expect(text).toContain("jsonb_exists(fv.value_json");
    expect(params).toContain(OPTION);
  });

  it("reads 'does not have this label' as including tasks with no labels", () => {
    const { text } = compile({
      filters: {
        op: "AND",
        conditions: [{ field: `cf:${LABELS_FIELD}`, op: "neq", value: OPTION }],
      },
    });
    expect(text).toContain("NOT EXISTS");
  });

  it("treats a task with no row for a field as having no value", () => {
    const { text } = compile({
      filters: {
        op: "AND",
        conditions: [{ field: `cf:${FIELD}`, op: "isNull" }],
      },
    });
    // Not `EXISTS (... AND fv.value_num IS NULL)`, which only finds tasks that
    // have a row holding a null.
    expect(text).toContain("NOT EXISTS");
    expect(text).toContain("fv.value_num IS NOT NULL");
  });

  it("treats an empty assignee filter as 'has no assignees'", () => {
    const { text } = compile({
      filters: { op: "AND", conditions: [{ field: "assignee", op: "isNull" }] },
    });
    expect(text).toContain("NOT EXISTS (SELECT 1 FROM task_assignees m WHERE m.task_id = t.id)");
  });

  it("uses = ANY for `in` so the query text is stable across value counts", () => {
    const one = compile({
      filters: { op: "AND", conditions: [{ field: "priority", op: "in", value: [1] }] },
    });
    const many = compile({
      filters: { op: "AND", conditions: [{ field: "priority", op: "in", value: [1, 2, 3] }] },
    });
    expect(one.text).toBe(many.text);
    expect(one.text).toContain("t.priority = ANY(");
  });

  it("rejects an empty `in` list", () => {
    expect(() =>
      compile({
        filters: { op: "AND", conditions: [{ field: "priority", op: "in", value: [] }] },
      }),
    ).toThrow(ViewCompileError);
  });

  it("scopes a list view through task_lists so multi-list tasks appear", () => {
    const { text } = compile();
    expect(text).toContain("FROM task_lists tl");
    expect(text).not.toContain("t.home_list_id = $");
  });

  it("adds no scope predicate for an everything view", () => {
    const { text } = compileViewQuery({
      workspaceId: WORKSPACE,
      viewerId: VIEWER,
      scope: { kind: "everything" },
      definition: DEFAULT_VIEW_DEFINITION,
    });
    expect(text).not.toContain("t.space_id =");
    expect(text).not.toContain("task_lists");
    // Permission alone defines what "everything" means.
    expect(text).toContain("JOIN access_index");
  });

  it("orders by the group key first, then the sort, then id", () => {
    const { text } = compile({
      grouping: { field: "status", dir: "asc" },
      sort: [{ field: "dueAt", dir: "desc" }],
    });
    const order = text.slice(text.indexOf("ORDER BY"));
    expect(order.indexOf("t.status_id")).toBeLessThan(order.indexOf("t.due_at"));
    expect(order.trimEnd().endsWith("t.id ASC") || order.includes("t.id ASC")).toBe(true);
  });

  it("sorts nulls last in both directions", () => {
    expect(compile({ sort: [{ field: "dueAt", dir: "asc" }] }).text).toContain(
      "t.due_at ASC NULLS LAST",
    );
    expect(compile({ sort: [{ field: "dueAt", dir: "desc" }] }).text).toContain(
      "t.due_at DESC NULLS LAST",
    );
  });

  it("refuses to sort by a multi-value field", () => {
    expect(() => compile({ sort: [{ field: "assignee", dir: "asc" }] })).toThrow(ViewCompileError);
  });

  it("caps the filter count", () => {
    const conditions = Array.from({ length: 40 }, () => ({
      field: "priority" as const,
      op: "eq" as const,
      value: 1,
    }));
    expect(() => compile({ filters: { op: "AND", conditions } })).toThrow(/at most/);
  });

  it("clamps the limit", () => {
    const { params } = compileViewQuery({
      workspaceId: WORKSPACE,
      viewerId: VIEWER,
      scope: { kind: "everything" },
      definition: DEFAULT_VIEW_DEFINITION,
      limit: 100_000,
    });
    expect(params.at(-1)).toBe(500);
  });

  it("does not use SELECT DISTINCT", () => {
    // Regression: DISTINCT forbids ORDER BY an expression outside the select
    // list, which broke every view sorted by a custom field. It was also
    // unnecessary — no join in this query can multiply rows.
    expect(compile().text).not.toContain("DISTINCT");
  });

  it("selects the group key so ordering can reference the alias", () => {
    const { text } = compile({ grouping: { field: "status", dir: "asc" } });
    expect(text).toContain("AS group_key");
    expect(text).toContain("ORDER BY group_key ASC NULLS LAST");
  });

  it("can sort by a custom field, which DISTINCT would have made impossible", () => {
    const { text } = compile({
      grouping: { field: "none", dir: "asc" },
      sort: [{ field: `cf:${FIELD}`, dir: "desc" }],
    });
    expect(text).toContain("FROM field_values fv");
    expect(text).not.toContain("DISTINCT");
  });

  it("sorts a custom field on its own typed column, not on text", () => {
    const { text } = compile({
      grouping: { field: "none", dir: "asc" },
      sort: [{ field: `cf:${FIELD}`, dir: "asc" }],
    });
    // Sorting numbers as text puts 10 before 9.
    expect(text).toContain("SELECT fv.value_num");
    expect(text).not.toContain("COALESCE(fv.value_num::text");
  });

  it("refuses to sort or group by a field holding a set", () => {
    expect(() =>
      compile({
        grouping: { field: "none", dir: "asc" },
        sort: [{ field: `cf:${LABELS_FIELD}`, dir: "asc" }],
      }),
    ).toThrow(/has no order/);

    expect(() => compile({ grouping: { field: `cf:${LABELS_FIELD}`, dir: "asc" } })).toThrow(
      /several values at once/,
    );
  });

  it("hides subtasks entirely in mode 3", () => {
    const { text } = compile({
      filters: { op: "AND", conditions: [], showSubtasks: 3 },
    });
    expect(text).toContain("t.parent_task_id IS NULL");
  });
});

describe("compileGroupCounts", () => {
  function counts(definition: Partial<ViewDefinition> = {}) {
    return compileGroupCounts({
      workspaceId: WORKSPACE,
      viewerId: VIEWER,
      scope: { kind: "list", id: LIST },
      definition: { ...DEFAULT_VIEW_DEFINITION, ...definition },
    });
  }

  it("groups and counts", () => {
    const { text } = counts();
    expect(text).toContain("COUNT(*)::int AS count");
    expect(text).toContain("GROUP BY group_key");
  });

  it("applies exactly the same permission and filter predicates as the row query", () => {
    // If these ever drift, a collapsed group header shows a count that includes
    // tasks the viewer cannot open.
    const rows = compile();
    const grouped = counts();
    expect(grouped.text).toContain("JOIN access_index ax");
    expect(grouped.text).toContain("t.deleted_at IS NULL");
    expect(grouped.params.slice(0, 2)).toEqual(rows.params.slice(0, 2));
  });

  it("refuses to count an ungrouped view", () => {
    expect(() => counts({ grouping: { field: "none", dir: "asc" } })).toThrow(ViewCompileError);
  });
});

describe("nested filter clauses", () => {
  const base = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    viewerId: "22222222-2222-4222-8222-222222222222",
    scope: { kind: "everything" } as const,
  };

  const compileWith = (filters: FilterGroup) =>
    compileViewQuery({ ...base, definition: { ...DEFAULT_VIEW_DEFINITION, filters } });

  it("brackets a nested OR inside an AND", () => {
    // The whole reason this exists: an unbracketed OR beside an AND means
    // something else entirely, and reads as if it means the right thing.
    const { text } = compileWith({
      op: "AND",
      conditions: [
        { field: "priority", op: "eq", value: 1 },
        {
          op: "OR",
          conditions: [
            { field: "dueAt", op: "isNull" },
            { field: "dueAt", op: "lte", value: "2026-09-30" },
          ],
        },
      ],
    });

    expect(text).toContain("(t.priority = $3 AND (t.due_at IS NULL OR t.due_at <= $4))");
  });

  it("compiles the overlap question a timeline asks", () => {
    // (start IS NULL OR start <= end) AND (due IS NULL OR due >= begin)
    const { text, params } = compileWith({
      op: "AND",
      conditions: [
        {
          op: "OR",
          conditions: [
            { field: "startAt", op: "isNull" },
            { field: "startAt", op: "lte", value: "2026-10-01" },
          ],
        },
        {
          op: "OR",
          conditions: [
            { field: "dueAt", op: "isNull" },
            { field: "dueAt", op: "gte", value: "2026-09-01" },
          ],
        },
      ],
    });

    expect(text).toContain("t.start_at IS NULL");
    expect(text).toContain("t.due_at IS NULL");
    expect(params).toContain("2026-10-01");
    expect(params).toContain("2026-09-01");
  });

  it("still binds every value inside a nested clause", () => {
    const { text, params } = compileWith({
      op: "OR",
      conditions: [
        { op: "AND", conditions: [{ field: "name", op: "contains", value: "'; DROP TABLE" }] },
      ],
    });

    expect(text).not.toContain("DROP TABLE");
    expect(params).toContain("%'; DROP TABLE%");
  });

  it("drops an empty clause rather than emitting ()", () => {
    const { text } = compileWith({
      op: "AND",
      conditions: [{ field: "priority", op: "eq", value: 1 }, { op: "OR", conditions: [] }],
    });

    expect(text).not.toContain("()");
    expect(text).toContain("t.priority = $3");
  });

  it("counts nested conditions against the ceiling", () => {
    const many = Array.from({ length: MAX_CONDITIONS + 1 }, () => ({
      field: "priority" as const,
      op: "eq" as const,
      value: 1,
    }));

    expect(() =>
      compileWith({ op: "AND", conditions: [{ op: "OR", conditions: many }] }),
    ).toThrow(/at most/);
  });

  it("refuses to nest deeper than the limit", () => {
    let clause: FilterGroup = {
      op: "AND",
      conditions: [{ field: "priority", op: "eq", value: 1 }],
    };
    for (let i = 0; i <= MAX_FILTER_DEPTH + 1; i++) {
      clause = { op: "AND", conditions: [clause] };
    }

    expect(() => compileWith(clause)).toThrow(/nest at most/);
  });

  it("leaves a flat definition compiling exactly as it did", () => {
    const flat = compileWith({
      op: "AND",
      conditions: [
        { field: "priority", op: "eq", value: 1 },
        { field: "statusGroup", op: "eq", value: "active" },
      ],
    });

    expect(flat.text).toContain("(t.priority = $3 AND s.group = $4)");
  });
});

/**
 * One number for a whole view — what a rollup key result is measured by.
 *
 * The checks that matter are not about arithmetic. They are that this shares
 * `buildBase` with the row query, so a goal counting a filter and a list
 * showing the same filter cannot disagree about permissions, archived tasks or
 * closed statuses (D-101).
 */
describe("compileAggregate", () => {
  function aggregate(
    spec: Parameters<typeof compileAggregate>[0]["aggregate"],
    overrides: Partial<ViewDefinition> = {},
  ) {
    return compileAggregate({
      workspaceId: WORKSPACE,
      viewerId: VIEWER,
      scope: { kind: "list", id: LIST },
      fields: CATALOG,
      definition: { ...DEFAULT_VIEW_DEFINITION, ...overrides },
      aggregate: spec,
    });
  }

  it("scopes by the access index, exactly as the row query does", () => {
    const { text, params } = aggregate({ fn: "count" });
    expect(text).toContain("JOIN access_index ax ON ax.list_id = t.home_list_id");
    expect(params[0]).toBe(VIEWER);
  });

  it("applies the definition's own filters", () => {
    const { text, params } = aggregate(
      { fn: "count" },
      {
        filters: {
          ...DEFAULT_VIEW_DEFINITION.filters,
          conditions: [{ field: "priority", op: "eq", value: 1 }],
        } as ViewDefinition["filters"],
      },
    );
    expect(text).toContain("t.priority");
    expect(params).toContain(1);
  });

  it("hides archived and closed tasks the same way a view does", () => {
    // The whole reason this shares buildBase: a goal that counted archived
    // tasks while the list did not would be a number nobody could explain.
    const { text } = aggregate({ fn: "count" });
    expect(text).toContain("t.archived_at IS NULL");
    expect(text).toContain("s.group IS NULL OR s.group <> 'closed'");
  });

  it("counts as a float, so a percentage does not divide integers", () => {
    expect(aggregate({ fn: "count" }).text).toContain("COUNT(*)::float8");
  });

  it("reads an empty sum as nought, and an empty average as nothing", () => {
    // A goal at the start of a quarter matches no tasks. "No progress" is a
    // number; the mean of nothing is genuinely undefined.
    expect(aggregate({ fn: "sum", field: "points" }).text).toContain("COALESCE(SUM(");
    expect(aggregate({ fn: "avg", field: "points" }).text).not.toContain("COALESCE(AVG(");
  });

  it("totals a numeric custom field through its own typed column", () => {
    const { text, params } = aggregate({ fn: "sum", field: `cf:${FIELD}` });
    expect(text).toContain("fv.value_num");
    expect(params).toContain(FIELD);
  });

  it("refuses to total a field that is not a number", () => {
    expect(() => aggregate({ fn: "sum", field: `cf:${TEXT_FIELD}` })).toThrow(ViewCompileError);
  });

  it("refuses a built-in that would total to something meaningless", () => {
    // Summing priority produces a number with no meaning, and averaging
    // position produces one with less.
    expect(() => aggregate({ fn: "sum", field: "priority" })).toThrow(/Cannot total/);
    expect(() => aggregate({ fn: "avg", field: "position" })).toThrow(/Cannot total/);
  });

  it("refuses a sum with no field rather than totalling rows", () => {
    expect(() => aggregate({ fn: "sum" })).toThrow(ViewCompileError);
  });

  it("refuses a function nobody declared", () => {
    // `source` is client input; a function name reaching the query as text
    // would be a way to write SQL into it.
    expect(() =>
      aggregate({ fn: "drop" as unknown as "count" }),
    ).toThrow(ViewCompileError);
  });

  it("never inlines a value", () => {
    const { text } = aggregate({ fn: "count" });
    expect(text).not.toContain(WORKSPACE);
    expect(text).not.toContain(VIEWER);
  });
});

describe("grouping by a multi-valued field", () => {
  function counts(field: string) {
    return compileGroupCounts({
      workspaceId: WORKSPACE,
      viewerId: VIEWER,
      scope: { kind: "list", id: LIST },
      fields: CATALOG,
      definition: {
        ...DEFAULT_VIEW_DEFINITION,
        grouping: { field: field as never, dir: "asc" },
      },
    });
  }

  /**
   * The bug a dashboard found.
   *
   * `builtinSql("assignee")` is `ta.user_id`, an alias that only exists inside
   * the EXISTS subquery a multi-value *filter* builds. Grouping by one used to
   * put that alias in a SELECT and GROUP BY of a query with no such join — so
   * it compiled to valid-looking SQL and Postgres refused it at run time with
   * `missing FROM-clause entry for table "ta"`. Compiling is not running.
   */
  it("is refused for the built-in ones, not silently mis-aliased", () => {
    for (const field of ["assignee", "watcher", "tag"]) {
      expect(() => counts(field)).toThrow(ViewCompileError);
      expect(() => counts(field)).toThrow(/several at once/);
    }
  });

  it("still allows the single-valued ones the board actually uses", () => {
    for (const field of ["status", "statusGroup", "priority", "list", "taskType"]) {
      expect(() => counts(field)).not.toThrow();
    }
  });

  it("refuses a multi-valued custom field the same way", () => {
    expect(() => counts(`cf:${LABELS_FIELD}`)).toThrow(/several values at once/);
  });
});
