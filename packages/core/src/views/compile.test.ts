import { describe, expect, it } from "vitest";

import { ViewCompileError, compileGroupCounts, compileViewQuery } from "./compile";
import { DEFAULT_VIEW_DEFINITION, type ViewDefinition } from "./types";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const VIEWER = "22222222-2222-4222-8222-222222222222";
const LIST = "33333333-3333-4333-8333-333333333333";
const FIELD = "44444444-4444-4444-8444-444444444444";

function compile(overrides: Partial<ViewDefinition> = {}, scopeId = LIST) {
  return compileViewQuery({
    workspaceId: WORKSPACE,
    viewerId: VIEWER,
    scope: { kind: "list", id: scopeId },
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

  it("routes a string custom-field value to value_text", () => {
    const { text } = compile({
      filters: {
        op: "AND",
        conditions: [{ field: `cf:${FIELD}`, op: "eq", value: "S1" }],
      },
    });
    expect(text).toContain("fv.value_text =");
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
