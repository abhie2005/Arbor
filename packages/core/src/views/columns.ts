/**
 * The `columns` half of a view definition.
 *
 * Filters and grouping decide *which* rows a view returns; `columns` decides
 * what a renderer shows of each one. Until the table view there was nothing
 * that read it — the list and the board each show a fixed set — so this module
 * is where a `ColumnSpec` first becomes something a cell can be drawn from.
 *
 * **Strict on write, lenient on read**, and the asymmetry is deliberate. A
 * column naming a field that does not exist is a mistake, and the moment to
 * refuse it is when someone saves it, where they can still fix it (D-056).
 * Refusing at *read* time instead means one deleted custom field takes every
 * saved view referencing it off the air — including the list and the board,
 * which read this module too. So `validateColumns` throws and `resolveColumns`
 * drops, and each is used at the end where its behaviour is the kind one.
 */

import {
  FIELD_TYPE_META,
  type FieldCatalog,
  type FieldConfig,
  type FieldOption,
  type FieldType,
} from "../fields";
import { ViewCompileError } from "./compile";
import { BUILTIN_FILTERABLE } from "./filterable";
import type { BuiltinField, ColumnSpec, FieldRef } from "./types";

/**
 * How a cell draws itself.
 *
 * Coarser than `FieldType` on purpose: a currency and a rating are both numbers
 * to the query layer and differ only in their suffix, but a status and a
 * dropdown are both "one of a fixed set of coloured options" and differ in
 * nothing a renderer cares about. The kinds are the shapes a cell can take,
 * not the types a field can have.
 */
export type ColumnKind =
  | "name"
  | "status"
  | "statusGroup"
  | "priority"
  | "date"
  | "user"
  | "users"
  | "tags"
  | "taskType"
  | "container"
  | "task"
  | "text"
  | "link"
  | "number"
  | "currency"
  | "duration"
  | "rating"
  | "progress"
  | "checkbox"
  | "choice"
  | "choices"
  | "location";

/** Right-aligned kinds — digits line up on the decimal, words do not. */
const NUMERIC_KINDS = new Set<ColumnKind>([
  "number",
  "currency",
  "duration",
  "rating",
  "progress",
]);

export interface ResolvedColumn {
  ref: FieldRef;
  label: string;
  kind: ColumnKind;
  custom: boolean;
  /** The `field_values.field_id` a custom column reads. Absent for built-ins. */
  fieldId?: string;
  width: number;
  align: "left" | "right";
  /**
   * False for anything the compiler refuses to order by — a set has no order
   * (`orderExpr` throws on multi-value fields), and a header that sorts nothing
   * when clicked is worse than a header that does not offer to.
   */
  sortable: boolean;
  /** Present for `choice` and `choices`, so a cell can colour an option. */
  options?: FieldOption[];
  /**
   * The custom field's own `typeConfig`. A cell cannot format a value without
   * it — a currency needs its code, a rating its maximum, a progress field its
   * ends — and re-reading the catalog on the render side would be a second
   * source for the same answer.
   */
  config?: FieldConfig;
}

export interface ResolvedColumns {
  columns: ResolvedColumn[];
  /**
   * Refs that named nothing resolvable, in definition order. Surfaced rather
   * than swallowed: a column that vanished silently looks like missing data.
   */
  dropped: FieldRef[];
}

interface BuiltinColumn {
  label: string;
  kind: ColumnKind;
  width: number;
}

/**
 * The built-in fields a table may show, and how wide each starts.
 *
 * `position` is absent, as it is from the filter list: a fractional index is an
 * ordering implementation detail and showing `a0V` in a column would be
 * exposing it as a sort key, which ADR 2 says never to do.
 *
 * Labels come from `BUILTIN_FILTERABLE` wherever it has one, so a field is not
 * "Due date" in the filter menu and "Due" in the column header.
 */
export const BUILTIN_COLUMNS: Partial<Record<BuiltinField, BuiltinColumn>> = {
  name: { label: "Name", kind: "name", width: 340 },
  status: { label: "Status", kind: "status", width: 140 },
  statusGroup: { label: "Status group", kind: "statusGroup", width: 120 },
  priority: { label: "Priority", kind: "priority", width: 90 },
  assignee: { label: "Assignee", kind: "users", width: 110 },
  watcher: { label: "Watcher", kind: "users", width: 110 },
  tag: { label: "Tag", kind: "tags", width: 150 },
  taskType: { label: "Task type", kind: "taskType", width: 110 },
  dueAt: { label: "Due date", kind: "date", width: 120 },
  startAt: { label: "Start date", kind: "date", width: 120 },
  createdAt: { label: "Created", kind: "date", width: 120 },
  updatedAt: { label: "Updated", kind: "date", width: 120 },
  completedAt: { label: "Completed", kind: "date", width: 120 },
  createdBy: { label: "Created by", kind: "user", width: 130 },
  points: { label: "Points", kind: "number", width: 80 },
  timeEstimate: { label: "Estimate", kind: "duration", width: 100 },
  list: { label: "List", kind: "container", width: 140 },
  space: { label: "Space", kind: "container", width: 140 },
  folder: { label: "Folder", kind: "container", width: 140 },
  parent: { label: "Parent task", kind: "task", width: 160 },
};

/** Custom field type → cell shape. Everything unlisted draws as text. */
const CUSTOM_KIND: Partial<Record<FieldType, ColumnKind>> = {
  number: "number",
  currency: "currency",
  rating: "rating",
  manual_progress: "progress",
  automatic_progress: "progress",
  checkbox: "checkbox",
  date: "date",
  drop_down: "choice",
  labels: "choices",
  users: "users",
  tasks: "task",
  relationship: "task",
  location: "location",
  url: "link",
  email: "link",
};

const DEFAULT_CUSTOM_WIDTH: Partial<Record<ColumnKind, number>> = {
  number: 90,
  currency: 110,
  rating: 100,
  progress: 120,
  checkbox: 70,
  date: 120,
  choice: 130,
  choices: 170,
  users: 110,
  task: 160,
  link: 180,
  location: 160,
};

/** Widths outside this range make a table unreadable or unusable. */
export const MIN_COLUMN_WIDTH = 56;
export const MAX_COLUMN_WIDTH = 720;

function isCustomRef(field: FieldRef): field is `cf:${string}` {
  return typeof field === "string" && field.startsWith("cf:");
}

function clampWidth(requested: number | undefined, fallback: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return fallback;
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(requested)));
}

function resolveOne(
  spec: ColumnSpec,
  catalog: FieldCatalog | undefined,
  names: ReadonlyMap<string, string>,
): ResolvedColumn | null {
  if (isCustomRef(spec.field)) {
    const field = catalog?.get(spec.field.slice(3));
    if (!field) return null;

    const meta = FIELD_TYPE_META[field.type];
    if (!meta) return null;

    const kind = CUSTOM_KIND[field.type] ?? "text";
    const options =
      kind === "choice" || kind === "choices"
        ? ((field.typeConfig as { options?: FieldOption[] }).options ?? [])
        : undefined;

    return {
      ref: spec.field,
      label: names.get(field.id) ?? meta.label,
      kind,
      custom: true,
      fieldId: field.id,
      width: clampWidth(spec.width, DEFAULT_CUSTOM_WIDTH[kind] ?? 140),
      align: NUMERIC_KINDS.has(kind) ? "right" : "left",
      // The compiler orders a custom column with a correlated subquery on its
      // typed column, which a set of values has no answer for.
      sortable: !meta.multi,
      config: field.typeConfig,
      ...(options ? { options } : {}),
    };
  }

  const builtin = BUILTIN_COLUMNS[spec.field as BuiltinField];
  if (!builtin) return null;

  return {
    ref: spec.field,
    label: BUILTIN_FILTERABLE[spec.field as BuiltinField]?.label ?? builtin.label,
    kind: builtin.kind,
    custom: false,
    width: clampWidth(spec.width, builtin.width),
    align: NUMERIC_KINDS.has(builtin.kind) ? "right" : "left",
    // Assignee, watcher and tag live in child tables: one task has many, and
    // `orderExpr` refuses them for the same reason it refuses a labels field.
    sortable: builtin.kind !== "users" && builtin.kind !== "tags",
  };
}

/**
 * The columns a renderer should draw, in definition order.
 *
 * Hidden columns are removed rather than flagged: `hidden` is how a column
 * chooser remembers a column's width and position while it is off, so a
 * renderer never needs to know about one.
 */
export function resolveColumns(
  specs: readonly ColumnSpec[] | undefined,
  catalog?: FieldCatalog,
  names: ReadonlyMap<string, string> = new Map(),
): ResolvedColumns {
  const columns: ResolvedColumn[] = [];
  const dropped: FieldRef[] = [];

  for (const spec of specs ?? []) {
    if (spec.hidden) continue;
    const resolved = resolveOne(spec, catalog, names);
    if (resolved) columns.push(resolved);
    else dropped.push(spec.field);
  }

  return { columns, dropped };
}

/**
 * Throws unless every column names something that exists.
 *
 * Called on the save path, alongside compiling the definition, so that the
 * property the filter bar has — an invalid view cannot be expressed — holds for
 * columns too. Hidden columns are checked as well: hiding a broken column does
 * not make it valid, and un-hiding it later should not be able to fail.
 */
export function validateColumns(
  specs: readonly ColumnSpec[] | undefined,
  catalog?: FieldCatalog,
): void {
  for (const spec of specs ?? []) {
    if (resolveOne({ ...spec, hidden: false }, catalog, new Map())) continue;

    if (isCustomRef(spec.field)) {
      throw new ViewCompileError(
        `A column references custom field ${spec.field.slice(3)}, which is not in the catalog`,
      );
    }
    throw new ViewCompileError(`A column references an unknown field: ${String(spec.field)}`);
  }
}
