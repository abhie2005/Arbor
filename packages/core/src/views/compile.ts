import {
  FIELD_TYPE_META,
  FieldError,
  type FieldCatalog,
  type FieldDefinition,
  fieldValueColumn,
  parseFilterValue,
} from "../fields";
import type {
  BuiltinField,
  FieldRef,
  FilterCondition,
  SortField,
  ViewDefinition,
  ViewScope,
} from "./types";

/**
 * Compiles a view definition into one parameterized SQL query.
 *
 * Three rules hold this together, and all three are load-bearing:
 *
 * 1. **The access index is joined first.** It is the most selective predicate in
 *    the query, and it makes permission filtering part of the plan rather than a
 *    post-processing pass that leaks private lists.
 * 2. **Nothing user-supplied is ever interpolated.** Field references resolve
 *    through a fixed map; every value becomes a bound parameter. A view
 *    definition is untrusted input — it arrives from the client.
 * 3. **Custom-field predicates are EXISTS subqueries** against the typed EAV
 *    columns, so each one uses an index instead of widening the row.
 * 4. **A custom field is asked for its type, never inspected for one.** The
 *    caller supplies a catalog of the fields the definition references, and the
 *    storage column comes from the declared type. Inferring it from the
 *    JavaScript type of the filter value — what this did before — produced a
 *    query against the wrong column that matched nothing and reported an empty
 *    view rather than an error (D-013, D-042).
 */

export interface CompileOptions {
  workspaceId: string;
  /** The user the query runs as. Drives the access-index join. */
  viewerId: string;
  definition: ViewDefinition;
  scope: ViewScope;
  /**
   * The custom fields this definition references, by id. Required whenever the
   * definition mentions a `cf:` field anywhere — filter, sort, or grouping.
   */
  fields?: FieldCatalog;
  limit?: number;
  /** Keyset cursor from the previous page. */
  after?: { sortValues: unknown[]; id: string };
}

export interface CompiledQuery {
  text: string;
  params: unknown[];
}

export class ViewCompileError extends Error {}

/** Hard ceiling — a view with 40 filters is a bug report, not a use case. */
export const MAX_CONDITIONS = 25;
export const MAX_SORTS = 5;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

/**
 * Built-in field → SQL expression. A closed map is the whole defence against
 * injection through `FieldRef`: anything not present here is rejected.
 */
const BUILTIN_SQL: Record<BuiltinField, string> = {
  name: "t.name",
  status: "t.status_id",
  statusGroup: "s.group",
  priority: "t.priority",
  assignee: "ta.user_id",
  watcher: "tw.user_id",
  tag: "tt.tag_id",
  taskType: "t.task_type_id",
  dueAt: "t.due_at",
  startAt: "t.start_at",
  createdAt: "t.created_at",
  updatedAt: "t.updated_at",
  completedAt: "t.completed_at",
  createdBy: "t.created_by",
  points: "t.points",
  timeEstimate: "t.time_estimate_ms",
  list: "t.home_list_id",
  space: "t.space_id",
  folder: "t.folder_id",
  parent: "t.parent_task_id",
  position: "t.position",
};

/** Fields that live in a child table and therefore need an EXISTS wrapper. */
const MULTI_VALUE_FIELDS = new Set<BuiltinField>(["assignee", "watcher", "tag"]);

const MULTI_VALUE_SOURCE: Partial<Record<BuiltinField, { table: string; column: string }>> = {
  assignee: { table: "task_assignees", column: "user_id" },
  watcher: { table: "task_watchers", column: "user_id" },
  tag: { table: "task_tags", column: "tag_id" },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCustomField(field: FieldRef): field is `cf:${string}` {
  return typeof field === "string" && field.startsWith("cf:");
}

function customFieldId(field: `cf:${string}`): string {
  const id = field.slice(3);
  if (!UUID_RE.test(id)) {
    throw new ViewCompileError(`Custom field reference is not a uuid: ${field}`);
  }
  return id;
}

function builtinSql(field: FieldRef): string {
  if (isCustomField(field)) {
    throw new ViewCompileError(`Expected a built-in field, received ${field}`);
  }
  const sql = BUILTIN_SQL[field as BuiltinField];
  if (!sql) throw new ViewCompileError(`Unknown field: ${String(field)}`);
  return sql;
}

/**
 * The field a `cf:` reference names, or a compile error.
 *
 * Refusing to compile without the catalog is the point: a view that silently
 * queries the wrong column is worse than one that fails to open, because the
 * first looks like an empty list and the second looks like a bug.
 */
function requireField(field: `cf:${string}`, catalog: FieldCatalog | undefined): FieldDefinition {
  const id = customFieldId(field);

  if (!catalog) {
    throw new ViewCompileError(
      `This view references custom field ${id}, so compiling it needs a field catalog`,
    );
  }

  const definition = catalog.get(id);
  if (!definition) {
    throw new ViewCompileError(`Custom field ${id} is not in the catalog`);
  }
  return definition;
}

class ParamBag {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

function comparisonSql(expr: string, condition: FilterCondition, params: ParamBag): string {
  const { op, value } = condition;

  switch (op) {
    case "isNull":
      return `${expr} IS NULL`;
    case "isNotNull":
      return `${expr} IS NOT NULL`;
    case "eq":
      return `${expr} = ${params.add(value)}`;
    case "neq":
      // NULL is "not equal" to a value in ordinary usage, but SQL disagrees.
      return `(${expr} IS DISTINCT FROM ${params.add(value)})`;
    case "gt":
      return `${expr} > ${params.add(value)}`;
    case "gte":
      return `${expr} >= ${params.add(value)}`;
    case "lt":
      return `${expr} < ${params.add(value)}`;
    case "lte":
      return `${expr} <= ${params.add(value)}`;
    case "contains":
      return `${expr} ILIKE ${params.add(`%${escapeLike(String(value))}%`)}`;
    case "notContains":
      return `(${expr} IS NULL OR ${expr} NOT ILIKE ${params.add(`%${escapeLike(String(value))}%`)})`;
    case "in":
    case "nin": {
      if (!Array.isArray(value) || value.length === 0) {
        throw new ViewCompileError(`Operator "${op}" needs a non-empty array`);
      }
      // = ANY($n) takes the whole array as one parameter, so the query text is
      // identical regardless of how many values were selected — which keeps the
      // prepared-statement cache useful.
      return op === "in"
        ? `${expr} = ANY(${params.add(value)})`
        : `(${expr} IS NULL OR NOT (${expr} = ANY(${params.add(value)})))`;
    }
    case "between": {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new ViewCompileError('Operator "between" needs a two-element array');
      }
      return `${expr} BETWEEN ${params.add(value[0])} AND ${params.add(value[1])}`;
    }
    default:
      throw new ViewCompileError(`Unsupported operator: ${String(op)}`);
  }
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A predicate on one custom field.
 *
 * Everything about the shape of this comes from the field's declared type: the
 * column, whether the comparison is a scalar test or a JSONB containment test,
 * and whether the operator is legal at all. The value is validated and coerced
 * on the way through, so `parseFilterValue` rejects a filter the query would
 * otherwise run and quietly return nothing for.
 */
function customFieldSql(
  ref: `cf:${string}`,
  condition: FilterCondition,
  params: ParamBag,
  catalog: FieldCatalog | undefined,
): string {
  const field = requireField(ref, catalog);
  const meta = FIELD_TYPE_META[field.type];
  const { op } = condition;

  let value: unknown;
  try {
    value = parseFilterValue(field, op, condition.value);
  } catch (error) {
    // The field module speaks in terms a form can render; the compiler's
    // callers catch ViewCompileError. Keep the message, change the type.
    if (error instanceof FieldError) throw new ViewCompileError(error.message);
    throw error;
  }

  const idParam = params.add(field.id);
  const rowFor = (predicate: string) =>
    `EXISTS (
      SELECT 1 FROM field_values fv
      WHERE fv.task_id = t.id AND fv.field_id = ${idParam} AND ${predicate}
    )`;

  if (meta.multi) {
    // Values are a JSON array of ids. `jsonb_exists` is the function behind the
    // `?` operator — spelled out because a bare `?` in query text is a
    // placeholder to several drivers, even though node-postgres is not one.
    const nonEmpty = `jsonb_array_length(COALESCE(fv.value_json, '[]'::jsonb)) > 0`;

    switch (op) {
      case "isNull":
        return `NOT ${rowFor(nonEmpty)}`;
      case "isNotNull":
        return rowFor(nonEmpty);
      case "eq":
        return rowFor(`jsonb_exists(fv.value_json, ${params.add(value)})`);
      case "neq":
        // "does not have this label" must include tasks with no labels at all,
        // which an EXISTS with a negated inner predicate would miss.
        return `NOT ${rowFor(`jsonb_exists(fv.value_json, ${params.add(value)})`)}`;
      case "in":
        return rowFor(`jsonb_exists_any(fv.value_json, ${params.add(value)}::text[])`);
      case "nin":
        return `NOT ${rowFor(`jsonb_exists_any(fv.value_json, ${params.add(value)}::text[])`)}`;
      default:
        throw new ViewCompileError(`Operator "${op}" does not apply to a ${meta.label} field`);
    }
  }

  const column = `fv.${fieldValueColumn(field)}`;

  // A task with no row for the field has no value for it. Testing `IS NULL`
  // inside the EXISTS would only find tasks that have a row holding a null,
  // which is not what "is empty" means to anyone.
  if (op === "isNull") return `NOT ${rowFor(`${column} IS NOT NULL`)}`;
  if (op === "isNotNull") return rowFor(`${column} IS NOT NULL`);

  return rowFor(comparisonSql(column, { ...condition, value }, params));
}

function conditionSql(
  condition: FilterCondition,
  params: ParamBag,
  fields: FieldCatalog | undefined,
): string {
  const { field } = condition;

  if (isCustomField(field)) {
    return customFieldSql(field, condition, params, fields);
  }

  const builtin = field as BuiltinField;

  if (MULTI_VALUE_FIELDS.has(builtin)) {
    const source = MULTI_VALUE_SOURCE[builtin];
    if (!source) throw new ViewCompileError(`No source table for ${builtin}`);

    // "assignee is null" means the task has no assignees at all — not that some
    // row exists with a null user. Same for isNotNull.
    if (condition.op === "isNull" || condition.op === "isNotNull") {
      const any = `EXISTS (SELECT 1 FROM ${source.table} m WHERE m.task_id = t.id)`;
      return condition.op === "isNull" ? `NOT ${any}` : any;
    }

    const negated = condition.op === "neq" || condition.op === "nin";
    const positive: FilterCondition = {
      ...condition,
      op: condition.op === "nin" ? "in" : condition.op === "neq" ? "eq" : condition.op,
    };
    const inner = comparisonSql(`m.${source.column}`, positive, params);
    const exists = `EXISTS (SELECT 1 FROM ${source.table} m WHERE m.task_id = t.id AND ${inner})`;
    return negated ? `NOT ${exists}` : exists;
  }

  return comparisonSql(builtinSql(field), condition, params);
}

function scopeSql(scope: ViewScope, params: ParamBag): string | null {
  switch (scope.kind) {
    case "everything":
      // No predicate: the access-index join already limits this to lists the
      // viewer can reach, which is exactly what "everything" means.
      return null;
    case "space":
      return `t.space_id = ${params.add(scope.id)}`;
    case "folder":
      return `t.folder_id = ${params.add(scope.id)}`;
    case "list":
      // Via task_lists, not t.home_list_id — a task added to this list from
      // elsewhere must still appear in it.
      return `EXISTS (SELECT 1 FROM task_lists tl WHERE tl.task_id = t.id AND tl.list_id = ${params.add(scope.id)})`;
    default:
      throw new ViewCompileError(`Unknown scope`);
  }
}

function orderExpr(sort: SortField, params: ParamBag, fields: FieldCatalog | undefined): string {
  const direction = sort.dir === "desc" ? "DESC" : "ASC";
  // Always nulls last, in both directions: "no due date" belongs at the bottom
  // of the list whether the sort is ascending or descending.
  const nulls = "NULLS LAST";

  if (isCustomField(sort.field)) {
    const field = requireField(sort.field, fields);
    const meta = FIELD_TYPE_META[field.type];

    if (meta.multi) {
      throw new ViewCompileError(
        `Cannot sort by "${field.type}" field ${field.id} — it holds a set, which has no order`,
      );
    }

    // A correlated scalar subquery keeps the sort key out of the join, so a
    // task with no value for the field sorts as NULL rather than dropping out.
    // The column comes from the declared type, so a number sorts numerically
    // and a date chronologically — the COALESCE-to-text this used to do sorted
    // 10 before 9 and 2026-01 before 2025-12.
    return `(SELECT fv.${fieldValueColumn(field)}
             FROM field_values fv
             WHERE fv.task_id = t.id AND fv.field_id = ${params.add(field.id)}) ${direction} ${nulls}`;
  }

  if (MULTI_VALUE_FIELDS.has(sort.field as BuiltinField)) {
    throw new ViewCompileError(`Cannot sort by multi-value field "${sort.field}"`);
  }

  return `${builtinSql(sort.field)} ${direction} ${nulls}`;
}

interface QueryBase {
  joins: string[];
  where: string[];
  params: ParamBag;
}

/**
 * The FROM/JOIN/WHERE half of the query, shared by the row query and the group
 * counts so the two can never drift apart on what a viewer is allowed to see.
 */
function buildBase(options: CompileOptions): QueryBase {
  const { workspaceId, viewerId, definition, scope } = options;
  const { filters } = definition;

  if (filters.conditions.length > MAX_CONDITIONS) {
    throw new ViewCompileError(
      `A view may have at most ${MAX_CONDITIONS} filters (received ${filters.conditions.length})`,
    );
  }

  const params = new ParamBag();
  const where: string[] = [];
  const joins: string[] = [];

  // 1. Permission first — the most selective predicate in the query.
  const viewerParam = params.add(viewerId);
  joins.push(
    `JOIN access_index ax ON ax.list_id = t.home_list_id AND ax.principal_id = ${viewerParam}`,
  );

  // Status is joined unconditionally: `showClosed` and status grouping both
  // need the group, and it is a single indexed lookup.
  joins.push("LEFT JOIN statuses s ON s.id = t.status_id");

  where.push(`t.workspace_id = ${params.add(workspaceId)}`);
  where.push("t.deleted_at IS NULL");

  if (!filters.includeArchived) where.push("t.archived_at IS NULL");
  if (!filters.showClosed) where.push("(s.group IS NULL OR s.group <> 'closed')");

  // Subtasks hidden entirely, or promoted to top-level rows. Mode 2 (nested
  // under their parent) is a rendering concern, so the query returns them.
  if (filters.showSubtasks === 3) where.push("t.parent_task_id IS NULL");

  const scopePredicate = scopeSql(scope, params);
  if (scopePredicate) where.push(scopePredicate);

  if (filters.search) {
    const term = params.add(`%${escapeLike(filters.search)}%`);
    where.push(`t.name ILIKE ${term}`);
  }

  if (filters.conditions.length > 0) {
    const joiner = filters.op === "OR" ? " OR " : " AND ";
    const parts = filters.conditions.map((c) => conditionSql(c, params, options.fields));
    where.push(`(${parts.join(joiner)})`);
  }

  return { joins, where, params };
}

/**
 * No DISTINCT, deliberately.
 *
 * Neither join can multiply rows — `access_index` is keyed on
 * (principal, list) and `statuses` on its primary key — and every multi-value
 * filter is an EXISTS subquery rather than a join, precisely so that the result
 * set stays one row per task. DISTINCT would add a sort or hash over the whole
 * result for no benefit, and it forbids ordering by any expression not in the
 * select list, which breaks sorting by a custom field.
 */
export function compileViewQuery(options: CompileOptions): CompiledQuery {
  const { definition } = options;
  const { grouping } = definition;
  const { joins, where, params } = buildBase(options);

  const columns = [
    "t.id, t.key, t.name, t.status_id, t.priority, t.parent_task_id",
    "t.due_at, t.due_has_time, t.start_at, t.points, t.time_estimate_ms",
    "t.home_list_id, t.space_id, t.folder_id, t.position, t.updated_at",
    "s.group AS status_group, ax.permission AS viewer_permission",
  ];

  // Ordering: group key first so rows arrive already clustered, then the view's
  // own sort, then id as a stable tiebreaker for keyset pagination.
  const order: string[] = [];

  if (grouping.field !== "none") {
    // Selected as `group_key` so the renderer gets the header value for free,
    // and so ORDER BY can reference the output alias instead of repeating a
    // correlated subquery.
    columns.push(`${groupKeyExpr(grouping.field, params, options.fields)} AS group_key`);
    order.push(`group_key ${grouping.dir === "desc" ? "DESC" : "ASC"} NULLS LAST`);
  }

  for (const sort of definition.sort.slice(0, MAX_SORTS)) {
    order.push(orderExpr(sort, params, options.fields));
  }
  order.push("t.id ASC");

  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const text = `SELECT
  ${columns.join(",\n  ")}
FROM tasks t
${joins.join("\n")}
WHERE ${where.join("\n  AND ")}
ORDER BY ${order.join(", ")}
LIMIT ${params.add(limit)}`;

  return { text, params: params.values };
}

/**
 * Group counts for the headers. A collapsed group still shows its count, so
 * this cannot be derived by counting the rows on the current page.
 */
export function compileGroupCounts(options: CompileOptions): CompiledQuery {
  const groupField = options.definition.grouping.field;

  if (groupField === "none") {
    throw new ViewCompileError("Cannot count groups for an ungrouped view");
  }

  const { joins, where, params } = buildBase(options);
  const keyExpr = groupKeyExpr(groupField, params, options.fields);

  return {
    text: `SELECT ${keyExpr} AS group_key, COUNT(*)::int AS count
FROM tasks t
${joins.join("\n")}
WHERE ${where.join("\n  AND ")}
GROUP BY group_key
ORDER BY group_key ASC NULLS LAST`,
    params: params.values,
  };
}

function groupKeyExpr(
  field: FieldRef,
  params: ParamBag,
  fields: FieldCatalog | undefined,
): string {
  if (isCustomField(field)) {
    const definition = requireField(field, fields);
    const meta = FIELD_TYPE_META[definition.type];

    // A task with three labels belongs to three groups. Grouping by one is a
    // renderer feature (a card appearing in several columns), not something a
    // single group key can express, so refuse rather than pick a member.
    if (meta.multi) {
      throw new ViewCompileError(
        `Cannot group by "${definition.type}" field ${definition.id} — a task can hold several values at once`,
      );
    }

    // Cast to text because the group key is a header label and a map key on the
    // renderer side; the ordering of groups is the grouping direction, not the
    // field's natural order.
    return `(SELECT fv.${fieldValueColumn(definition)}::text
            FROM field_values fv
            WHERE fv.task_id = t.id AND fv.field_id = ${params.add(definition.id)})`;
  }
  return builtinSql(field);
}
