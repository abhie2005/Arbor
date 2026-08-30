/**
 * The view definition.
 *
 * Every view type serializes to this same object — a board is just
 * `grouping.field = "status"`, a calendar is a date field on an axis, a table is
 * a list with every column shown. One compiler, many renderers: that is why
 * adding a renderer costs days instead of weeks.
 */

export type ViewType =
  | "list"
  | "board"
  | "table"
  | "calendar"
  | "gantt"
  | "timeline"
  | "workload"
  | "map"
  | "activity"
  | "form"
  | "doc";

/** Built-in fields addressable in filters, sorts, and grouping. */
export type BuiltinField =
  | "name"
  | "status"
  | "statusGroup"
  | "priority"
  | "assignee"
  | "watcher"
  | "tag"
  | "taskType"
  | "dueAt"
  | "startAt"
  | "createdAt"
  | "updatedAt"
  | "completedAt"
  | "createdBy"
  | "points"
  | "timeEstimate"
  | "list"
  | "space"
  | "folder"
  | "parent"
  | "position";

/**
 * A field reference. Custom fields are addressed as `cf:<uuid>` so the same
 * string namespace covers both, and a view definition stays a plain JSON blob.
 */
export type FieldRef = BuiltinField | `cf:${string}`;

export type FilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "nin"
  | "contains"
  | "notContains"
  | "isNull"
  | "isNotNull"
  | "between";

export interface FilterCondition {
  field: FieldRef;
  op: FilterOp;
  /** Absent for isNull / isNotNull; a two-element array for between. */
  value?: unknown;
}

export interface FilterGroup {
  op: "AND" | "OR";
  conditions: FilterCondition[];
  /** Free-text search across name and description. */
  search?: string;
  /** Closed-group tasks are hidden unless this is true. */
  showClosed?: boolean;
  /** 1 = as separate rows, 2 = nested under parents, 3 = hidden. */
  showSubtasks?: 1 | 2 | 3;
  includeArchived?: boolean;
}

export interface SortField {
  field: FieldRef;
  dir: "asc" | "desc";
}

export interface Grouping {
  field: FieldRef | "none";
  dir: "asc" | "desc";
  /** Group keys the viewer has collapsed. Presentation only — never filters. */
  collapsed?: string[];
}

export interface ColumnSpec {
  field: FieldRef;
  width?: number;
  hidden?: boolean;
}

export interface ViewDefinition {
  grouping: Grouping;
  /** Swimlanes: a second grouping axis, used by board and timeline. */
  divide?: Grouping;
  sort: SortField[];
  filters: FilterGroup;
  columns: ColumnSpec[];
  settings?: Record<string, unknown>;
}

/**
 * Where a view reads from. `everything` spans every list the viewer can reach —
 * which the compiler resolves from the access index, not from a parent id.
 */
export type ViewScope =
  | { kind: "everything" }
  | { kind: "space"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "list"; id: string };

/** Keyset pagination. Never OFFSET — users scroll deep inside a board column. */
export interface Cursor {
  /** Values of the sort keys from the last row of the previous page. */
  after: unknown[];
  id: string;
}

export const DEFAULT_VIEW_DEFINITION: ViewDefinition = {
  grouping: { field: "status", dir: "asc" },
  sort: [{ field: "position", dir: "asc" }],
  filters: { op: "AND", conditions: [], showClosed: false, showSubtasks: 2 },
  columns: [
    { field: "status" },
    { field: "name" },
    { field: "assignee" },
    { field: "priority" },
    { field: "dueAt" },
  ],
};
