/**
 * What a filter bar is allowed to offer.
 *
 * The compiler already refuses a filter that makes no sense — `>` on a
 * dropdown, a number against a text field (D-042) — but refusing is the last
 * line, not the interface. A UI that offers an option the server will reject
 * has already failed the user: they made a choice, waited, and got an error for
 * something that was never possible.
 *
 * So the same knowledge that powers the rejection is published here for the UI
 * to build menus from. Custom fields answer through `FIELD_TYPE_META`; built-in
 * fields answer through the table below. One source, two consumers, no drift.
 */

import { FIELD_TYPE_META, type FieldCatalog, FieldError } from "../fields";
import type { BuiltinField, FieldRef, FilterOp } from "./types";

/**
 * How a value is chosen, which is a question about the control to render —
 * not about the column it lands in. Both a status and an assignee are `uuid`
 * as far as SQL cares; one needs a status menu and the other a people picker.
 */
export type ValueInput =
  | "text"
  | "number"
  | "date"
  /** The field's own dropdown or label options. */
  | "choice"
  | "status"
  | "statusGroup"
  | "priority"
  | "user"
  | "tag"
  | "taskType"
  | "container"
  | "task"
  | "none";

export interface FilterableField {
  ref: FieldRef;
  label: string;
  input: ValueInput;
  ops: readonly FilterOp[];
  /** True for `cf:` references, so the UI can group them under a heading. */
  custom: boolean;
  /**
   * Present when `input` is "choice". A dropdown's legal values are defined by
   * the field itself, so they travel with it — otherwise the UI would offer a
   * free-text box and the only valid input would be an option's uuid, which
   * nobody knows and nobody should have to.
   */
  options?: { id: string; name: string }[];
}

const TEXT_OPS = ["eq", "neq", "contains", "notContains", "isNull", "isNotNull"] as const;
const ORDERED_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "isNull",
  "isNotNull",
] as const;
const SET_OPS = ["eq", "neq", "in", "nin", "isNull", "isNotNull"] as const;

interface BuiltinMeta {
  label: string;
  input: ValueInput;
  ops: readonly FilterOp[];
}

/**
 * Built-in fields, and the operators each one actually supports.
 *
 * `position` is deliberately absent: it is a fractional index, an
 * implementation detail of ordering, and "position is greater than a1V" is not
 * a question anyone has. It stays sortable and ungroupable-by, but it is not
 * offered as a filter.
 */
export const BUILTIN_FILTERABLE: Partial<Record<BuiltinField, BuiltinMeta>> = {
  name: { label: "Name", input: "text", ops: TEXT_OPS },
  status: { label: "Status", input: "status", ops: SET_OPS },
  statusGroup: { label: "Status group", input: "statusGroup", ops: SET_OPS },
  priority: { label: "Priority", input: "priority", ops: SET_OPS },
  assignee: { label: "Assignee", input: "user", ops: SET_OPS },
  watcher: { label: "Watcher", input: "user", ops: SET_OPS },
  tag: { label: "Tag", input: "tag", ops: SET_OPS },
  taskType: { label: "Task type", input: "taskType", ops: SET_OPS },
  dueAt: { label: "Due date", input: "date", ops: ORDERED_OPS },
  startAt: { label: "Start date", input: "date", ops: ORDERED_OPS },
  createdAt: { label: "Created", input: "date", ops: ORDERED_OPS },
  updatedAt: { label: "Updated", input: "date", ops: ORDERED_OPS },
  completedAt: { label: "Completed", input: "date", ops: ORDERED_OPS },
  createdBy: { label: "Created by", input: "user", ops: SET_OPS },
  points: { label: "Points", input: "number", ops: ORDERED_OPS },
  timeEstimate: { label: "Estimate", input: "number", ops: ORDERED_OPS },
  list: { label: "List", input: "container", ops: SET_OPS },
  space: { label: "Space", input: "container", ops: SET_OPS },
  folder: { label: "Folder", input: "container", ops: SET_OPS },
  parent: { label: "Parent task", input: "task", ops: SET_OPS },
};

/** Which control a custom field's value needs, from its type. */
const CUSTOM_INPUT: Partial<Record<string, ValueInput>> = {
  drop_down: "choice",
  labels: "choice",
  number: "number",
  currency: "number",
  rating: "number",
  manual_progress: "number",
  automatic_progress: "number",
  date: "date",
  users: "user",
  tasks: "task",
  relationship: "task",
  checkbox: "none",
  location: "none",
};

function isCustomRef(field: FieldRef): field is `cf:${string}` {
  return typeof field === "string" && field.startsWith("cf:");
}

/**
 * Everything a filter bar may offer, built-ins first then custom fields.
 *
 * Archived custom fields are excluded: a saved view may still filter on one and
 * must keep working (that is why the catalog keeps them), but offering one in a
 * menu invites people to start using a field that is on its way out.
 */
export function filterableFields(
  catalog: FieldCatalog | undefined,
  archived: ReadonlySet<string> = new Set(),
  names: ReadonlyMap<string, string> = new Map(),
): FilterableField[] {
  const builtins = Object.entries(BUILTIN_FILTERABLE).map(([ref, meta]) => ({
    ref: ref as BuiltinField,
    label: meta.label,
    input: meta.input,
    ops: meta.ops,
    custom: false,
  }));

  const custom = [...(catalog?.values() ?? [])]
    .filter((field) => !archived.has(field.id))
    .map((field) => {
      const meta = FIELD_TYPE_META[field.type];
      const input = CUSTOM_INPUT[field.type] ?? "text";
      const options =
        input === "choice"
          ? ((field.typeConfig as { options?: { id: string; name: string }[] }).options ?? []).map(
              (option) => ({ id: option.id, name: option.name }),
            )
          : undefined;

      return {
        ref: `cf:${field.id}` as const,
        label: names.get(field.id) ?? meta.label,
        input,
        ops: meta.ops,
        custom: true,
        ...(options ? { options } : {}),
      };
    });

  return [...builtins, ...custom];
}

/** The operators legal for one field. Throws rather than guessing. */
export function operatorsFor(field: FieldRef, catalog?: FieldCatalog): readonly FilterOp[] {
  if (isCustomRef(field)) {
    const definition = catalog?.get(field.slice(3));
    if (!definition) {
      throw new FieldError(`Custom field ${field} is not in the catalog`);
    }
    return FIELD_TYPE_META[definition.type].ops;
  }

  const meta = BUILTIN_FILTERABLE[field as BuiltinField];
  if (!meta) throw new FieldError(`Field "${String(field)}" cannot be filtered on`);
  return meta.ops;
}

export const OPERATOR_LABELS: Record<FilterOp, string> = {
  eq: "is",
  neq: "is not",
  gt: "is after",
  gte: "is on or after",
  lt: "is before",
  lte: "is on or before",
  in: "is any of",
  nin: "is none of",
  contains: "contains",
  notContains: "does not contain",
  isNull: "is empty",
  isNotNull: "is not empty",
  between: "is between",
};

/**
 * Comparison words differ by type and saying the wrong one is worse than
 * saying nothing: "due date is greater than" reads like a bug, and "points is
 * after 3" reads like a different bug.
 */
export function operatorLabel(op: FilterOp, input: ValueInput): string {
  if (input === "date") return OPERATOR_LABELS[op];
  if (op === "gt") return "is more than";
  if (op === "gte") return "is at least";
  if (op === "lt") return "is less than";
  if (op === "lte") return "is at most";
  return OPERATOR_LABELS[op];
}

/** Operators that take no value, so the UI hides the value control entirely. */
export function opNeedsValue(op: FilterOp): boolean {
  return op !== "isNull" && op !== "isNotNull";
}
