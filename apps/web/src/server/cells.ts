import "server-only";

import type { FieldOption, ResolvedColumn } from "@arbor/core";

import type { ColumnValues } from "./column-values";
import type { CompiledTaskRow, StatusRow } from "./views";

/**
 * One cell, resolved on the server.
 *
 * The table component receives *values*, never ids and never lookup maps. A
 * cell says "the people are Avery and Jordan", not "user ids a1.. and b2..
 * plus here is every user in the workspace so you can join them yourself".
 *
 * Two reasons that boundary sits here. Sending the maps would ship the whole
 * workspace's people, tags and containers to the browser to render a handful
 * of visible rows. And a client that joins ids to names is a second place
 * where a missing name has to be handled, which is how a table ends up
 * rendering a raw uuid at someone.
 *
 * The shape is a discriminated union so the renderer's switch is exhaustive:
 * a new column kind that nobody wrote a cell for is a type error rather than
 * a blank column.
 */
export type Cell =
  | { k: "empty" }
  | { k: "name" }
  | { k: "text"; text: string }
  | { k: "link"; text: string; href: string }
  | { k: "num"; text: string }
  | { k: "date"; iso: string; hasTime: boolean }
  | { k: "status"; name: string; group: string | null }
  | { k: "priority"; value: number | null }
  | { k: "people"; names: string[] }
  | { k: "chips"; chips: { name: string; color: string | null }[] }
  | { k: "bool"; value: boolean }
  | { k: "rating"; value: number; max: number }
  | { k: "progress"; percent: number; label: string };

const EMPTY: Cell = { k: "empty" };

export interface CellContext {
  values: ColumnValues;
  statuses: readonly StatusRow[];
  /** Already loaded for every renderer, so it is passed rather than refetched. */
  assignees: ReadonlyMap<string, string[]>;
}

/** Every cell of one row, keyed by column ref. */
export function cellsFor(
  row: CompiledTaskRow,
  columns: readonly ResolvedColumn[],
  context: CellContext,
): Record<string, Cell> {
  const cells: Record<string, Cell> = {};
  for (const column of columns) {
    cells[String(column.ref)] = column.custom
      ? customCell(row, column, context)
      : builtinCell(row, column, context);
  }
  return cells;
}

function builtinCell(row: CompiledTaskRow, column: ResolvedColumn, context: CellContext): Cell {
  const { values, statuses } = context;

  switch (column.ref) {
    case "name":
      return { k: "name" };

    case "status": {
      const status = statuses.find((candidate) => candidate.id === row.status_id);
      return status ? { k: "status", name: status.name, group: status.group } : EMPTY;
    }

    case "statusGroup":
      // The group, not the status name: a custom "Shipping" status reports
      // "Active", which is the thing every rule in the product keys off (D-014).
      return row.status_group ? { k: "text", text: groupLabel(row.status_group) } : EMPTY;

    case "priority":
      return { k: "priority", value: row.priority };

    case "assignee":
      return people(context.assignees.get(row.id));

    case "watcher":
      return people(values.watchers.get(row.id));

    case "tag": {
      const tags = values.tags.get(row.id) ?? [];
      return tags.length > 0
        ? { k: "chips", chips: tags.map((tag) => ({ name: tag.name, color: tag.color })) }
        : EMPTY;
    }

    case "taskType":
      return text(row.task_type_id ? values.taskTypes.get(row.task_type_id) : null);

    case "createdBy":
      return people(row.created_by ? [values.people.get(row.created_by) ?? ""] : []);

    case "list":
      return text(values.containers.get(row.home_list_id as string));
    case "space":
      return text(values.containers.get(row.space_id as string));
    case "folder":
      return text(values.containers.get(row.folder_id as string));

    case "parent": {
      const parent = row.parent_task_id ? values.tasks.get(row.parent_task_id) : undefined;
      return parent ? { k: "text", text: parent.key ? `${parent.key} ${parent.name}` : parent.name } : EMPTY;
    }

    // A due or start date may be a calendar day; the audit stamps never are.
    case "dueAt":
      return date(row.due_at, row.due_has_time);
    case "startAt":
      return date(row.start_at as string | null, row.start_has_time);
    case "createdAt":
      return date(row.created_at, true);
    case "updatedAt":
      return date(row.updated_at as string | null, true);
    case "completedAt":
      return date(row.completed_at, true);

    case "points":
      return number(row.points as number | null);
    case "timeEstimate": {
      const ms = row.time_estimate_ms as number | null;
      return ms === null || ms === undefined ? EMPTY : { k: "num", text: duration(ms) };
    }

    default:
      return EMPTY;
  }
}

function customCell(row: CompiledTaskRow, column: ResolvedColumn, context: CellContext): Cell {
  const value = column.fieldId ? context.values.custom.get(row.id)?.get(column.fieldId) : undefined;
  if (value === undefined || value === null || value === "") return EMPTY;

  const config = (column.config ?? {}) as Record<string, unknown>;

  switch (column.kind) {
    case "checkbox":
      return { k: "bool", value: value === true };

    case "date":
      // A date field declares whether it carries a time, the same distinction
      // `due_has_time` makes on the task itself.
      return date(String(value), config.includeTime === true);

    case "number":
      return number(Number(value), config.precision as number | undefined);

    case "currency":
      return {
        k: "num",
        text: currency(Number(value), config.code as string | undefined, config.precision as number | undefined),
      };

    case "rating":
      return { k: "rating", value: Number(value), max: Number(config.max ?? 5) };

    case "progress": {
      const start = Number(config.start ?? 0);
      const end = Number(config.end ?? 100);
      const span = end - start;
      // A zero span would divide by nothing; a field configured 5→5 is a
      // misconfiguration, not a reason for the row to be NaN%.
      const percent = span === 0 ? 0 : clamp(((Number(value) - start) / span) * 100);
      return { k: "progress", percent, label: `${Math.round(percent)}%` };
    }

    case "choice":
      return chipsFor([value], column.options);

    case "choices":
      return chipsFor(Array.isArray(value) ? value : [value], column.options);

    case "users": {
      const ids = Array.isArray(value) ? value : [value];
      return people(ids.map((id) => context.values.people.get(String(id)) ?? ""));
    }

    case "task": {
      const ids = Array.isArray(value) ? value : [value];
      const names = ids
        .map((id) => context.values.tasks.get(String(id)))
        .filter((task): task is { key: string | null; name: string } => task !== undefined)
        .map((task) => task.name);
      return names.length > 0 ? { k: "text", text: names.join(", ") } : EMPTY;
    }

    case "link": {
      const raw = String(value);
      const href = raw.includes("@") && !raw.startsWith("http") ? `mailto:${raw}` : raw;
      return { k: "link", text: raw, href };
    }

    case "location": {
      const place = value as { formatted?: string; name?: string };
      return text(place.formatted ?? place.name ?? null);
    }

    default:
      return { k: "text", text: String(value) };
  }
}

/**
 * An option's id resolved to its name and colour.
 *
 * Values store the option **id**, never the name (D-041), so an option that
 * has been deleted from the field leaves a value pointing at nothing. Showing
 * the raw uuid would be worse than showing nothing, and dropping it silently
 * would hide that the data is still there — so it renders as an unnamed chip.
 */
function chipsFor(raw: unknown[], options: FieldOption[] | undefined): Cell {
  const chips = raw.map((id) => {
    const option = options?.find((candidate) => candidate.id === String(id));
    return { name: option?.name ?? "—", color: option?.color ?? null };
  });
  return chips.length > 0 ? { k: "chips", chips } : EMPTY;
}

function people(names: readonly string[] | undefined): Cell {
  const present = (names ?? []).filter((name) => name !== "");
  return present.length > 0 ? { k: "people", names: [...present] } : EMPTY;
}

function text(value: string | null | undefined): Cell {
  return value ? { k: "text", text: value } : EMPTY;
}

function date(value: string | null | undefined, hasTime: boolean): Cell {
  return value ? { k: "date", iso: value, hasTime } : EMPTY;
}

function number(value: number | null | undefined, precision?: number): Cell {
  if (value === null || value === undefined || Number.isNaN(value)) return EMPTY;
  return { k: "num", text: precision === undefined ? String(value) : value.toFixed(precision) };
}

function currency(value: number, code: string | undefined, precision: number | undefined): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: code ?? "USD",
      minimumFractionDigits: precision ?? 2,
      maximumFractionDigits: precision ?? 2,
    }).format(value);
  } catch {
    // An unknown currency code throws rather than falling back, and a table
    // that will not render is a worse answer than an unformatted number.
    return value.toFixed(precision ?? 2);
  }
}

/** Estimates are stored in milliseconds and read in hours. */
function duration(ms: number): string {
  const hours = ms / 3_600_000;
  return hours >= 1 ? `${round(hours)}h` : `${Math.round(ms / 60_000)}m`;
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function clamp(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}

function groupLabel(group: string): string {
  return { not_started: "Not started", active: "Active", done: "Done", closed: "Closed" }[group] ?? group;
}
