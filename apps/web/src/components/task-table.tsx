"use client";

import {
  type Operation,
  type ResolvedColumn,
  type SortField,
  dateFrame,
  encodeSort,
  isOverdue,
} from "@arbor/core";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";

import type { Cell } from "@/server/cells";
import { archiveTask, cycleStatus, renameTask, setPriority } from "@/server/actions";

import { useTaskAction } from "./use-task-action";

/**
 * The table renderer.
 *
 * It draws one column per entry in the view definition's `columns`, which is
 * the half of a definition nothing read until now — the list and the board
 * each show a fixed set. Everything it needs has already been resolved on the
 * server: a cell arrives as a value with a shape, never as an id plus a map to
 * look it up in.
 *
 * The interactive cells are the ones the list already has — status, priority,
 * name, archive — reached through the same server actions, so undo covers a
 * change made here exactly as it covers one made there.
 */

export interface TableRowData {
  id: string;
  key: string | null;
  name: string;
  subtaskCount: number;
  statusGroup: string | null;
  priority: number | null;
  cells: Record<string, Cell>;
}

export function TaskTable({
  columns,
  rows,
  sort,
}: {
  columns: ResolvedColumn[];
  rows: TableRowData[];
  /** The sort in force, saved or from the URL — headers read their state from it. */
  sort: SortField[];
}) {
  if (columns.length === 0) {
    return (
      <p className="table-empty" role="status">
        This view has no columns to show.
      </p>
    );
  }

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={String(column.ref)}
                style={{ width: column.width }}
                data-align={column.align}
                scope="col"
                aria-sort={ariaSort(column, sort)}
              >
                <ColumnHeader column={column} sort={sort} />
              </th>
            ))}
            {/* Unlabelled: the archive control needs a column, not a heading. */}
            <th className="table-actions" scope="col" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <TableRow key={row.id} row={row} columns={columns} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A header that sorts, in three states: unsorted, ascending, descending, and
 * back to unsorted.
 *
 * The third state matters. Without it a saved view's own order — usually
 * `position`, the order people dragged things into — becomes unreachable once
 * anyone clicks a header, and "put it back" is not something a user should
 * have to know to do by editing the URL.
 *
 * It is a link, not a button: sorting is a navigation to a different address
 * for the same view (D-055), so it opens in a new tab, it is in the history,
 * and it works before the page has hydrated.
 */
function ColumnHeader({ column, sort }: { column: ResolvedColumn; sort: SortField[] }) {
  const pathname = usePathname();
  const params = useSearchParams();

  if (!column.sortable) {
    // A set has no order, and the compiler refuses to invent one. Saying so
    // when asked beats a header that looks clickable and does nothing.
    return (
      <span className="th-plain" title={`${column.label} cannot be sorted — it holds a set of values`}>
        {column.label}
      </span>
    );
  }

  const active = sort[0]?.field === column.ref ? sort[0] : null;
  const next: SortField[] | null =
    active === null
      ? [{ field: column.ref, dir: "asc" }]
      : active.dir === "asc"
        ? [{ field: column.ref, dir: "desc" }]
        : null;

  const query = new URLSearchParams(params.toString());
  const encoded = next === null ? null : encodeSort(next);
  if (encoded === null) query.delete("s");
  else query.set("s", encoded);

  const href = query.size > 0 ? `${pathname}?${query.toString()}` : pathname;

  return (
    <Link
      className="th-sort"
      href={href}
      data-active={active !== null || undefined}
      title={
        next === null
          ? `Stop sorting by ${column.label}`
          : `Sort by ${column.label}, ${next[0]?.dir === "asc" ? "ascending" : "descending"}`
      }
    >
      {column.label}
      <span className="th-arrow">{active === null ? "" : active.dir === "asc" ? "▲" : "▼"}</span>
    </Link>
  );
}

function ariaSort(
  column: ResolvedColumn,
  sort: SortField[],
): "ascending" | "descending" | "none" | undefined {
  if (!column.sortable) return undefined;
  if (sort[0]?.field !== column.ref) return "none";
  return sort[0].dir === "asc" ? "ascending" : "descending";
}

function TableRow({ row, columns }: { row: TableRowData; columns: ResolvedColumn[] }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(row.name);
  const { run, pending, failure } = useTaskAction();
  const act = (action: () => Promise<Operation[]>) => run(action, () => setName(row.name));

  return (
    <tr data-pending={pending || undefined} data-failed={failure ? true : undefined}>
      {columns.map((column) => {
        const cell = row.cells[String(column.ref)] ?? { k: "empty" };

        return (
          <td key={String(column.ref)} data-align={column.align} title={failure ?? undefined}>
            {cell.k === "name" ? (
              editing ? (
                <input
                  className="title-input"
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onBlur={() => {
                    setEditing(false);
                    if (name.trim() && name !== row.name) act(() => renameTask(row.id, name));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      setName(row.name);
                      setEditing(false);
                    }
                  }}
                />
              ) : (
                <span className="table-name">
                  {/* The permalink, for the same reason as the list (D-082). */}
                  <a className="key task-link" href={`/t/${row.key ?? row.id}`} title="Open task">
                    {row.key ?? "—"}
                  </a>
                  <button type="button" className="title" onClick={() => setEditing(true)}>
                    {name}
                  </button>
                  {row.subtaskCount > 0 ? (
                    <span className="sub">{row.subtaskCount}</span>
                  ) : null}
                </span>
              )
            ) : (
              <CellValue
                cell={cell}
                onCycleStatus={() => act(() => cycleStatus(row.id))}
                onCyclePriority={() =>
                  act(() => setPriority(row.id, nextPriority(row.priority)))
                }
                label={row.name}
              />
            )}
          </td>
        );
      })}

      <td className="table-actions">
        <button
          type="button"
          className="archive"
          title="Archive"
          aria-label={`Archive ${row.name}`}
          onClick={() => act(() => archiveTask(row.id))}
        >
          ×
        </button>
      </td>
    </tr>
  );
}

const PRIORITY_CYCLE = [null, 1, 2, 3, 4] as const;

function nextPriority(current: number | null): number | null {
  const index = PRIORITY_CYCLE.indexOf(current as never);
  return PRIORITY_CYCLE[(index + 1) % PRIORITY_CYCLE.length] ?? null;
}

/**
 * One cell's value.
 *
 * The switch is exhaustive over `Cell`, so adding a column kind without a cell
 * to draw it is a type error rather than a column of blanks.
 */
function CellValue({
  cell,
  onCycleStatus,
  onCyclePriority,
  label,
}: {
  cell: Cell;
  onCycleStatus: () => void;
  onCyclePriority: () => void;
  label: string;
}) {
  switch (cell.k) {
    case "empty":
      return <span className="cell-empty">—</span>;

    case "name":
      // Handled by the row, which owns the editing state.
      return null;

    case "text":
      return <span className="cell-text">{cell.text}</span>;

    case "num":
      return <span className="cell-num">{cell.text}</span>;

    case "link":
      return (
        <a className="cell-link" href={cell.href} rel="noreferrer noopener" target="_blank">
          {cell.text}
        </a>
      );

    case "date": {
      const due = formatDate(cell.iso, cell.hasTime);
      return (
        <span className="date" data-overdue={due.overdue}>
          {due.label}
        </span>
      );
    }

    case "status":
      return (
        <button
          type="button"
          className="cell-status"
          title="Advance status"
          aria-label={`Advance status of ${label}`}
          onClick={onCycleStatus}
        >
          <span className="dot" data-group={cell.group ?? undefined} />
          {cell.name}
        </button>
      );

    case "priority":
      return (
        <button
          type="button"
          className="flag"
          data-priority={cell.value ?? undefined}
          title="Change priority"
          aria-label={`Change priority of ${label}`}
          onClick={onCyclePriority}
        >
          {cell.value ? "▲" : "△"}
        </button>
      );

    case "people":
      return (
        <span className="avatars">
          {cell.names.map((person) => (
            <span
              key={person}
              className="avatar"
              style={{ background: avatarColor(person) }}
              title={person}
            >
              {initials(person)}
            </span>
          ))}
        </span>
      );

    case "chips":
      return (
        <span className="chips">
          {cell.chips.map((chip, index) => (
            <span
              // Two labels may share a name if an option was duplicated, so the
              // index is part of the key rather than the name alone.
              key={`${chip.name}-${index}`}
              className="chip"
              style={chip.color ? { borderColor: chip.color, color: chip.color } : undefined}
            >
              {chip.name}
            </span>
          ))}
        </span>
      );

    case "bool":
      return (
        <span className="cell-bool" aria-label={cell.value ? "Yes" : "No"}>
          {cell.value ? "✓" : "·"}
        </span>
      );

    case "rating":
      return (
        <span className="cell-rating" aria-label={`${cell.value} out of ${cell.max}`}>
          {"★".repeat(Math.min(cell.value, cell.max))}
          <span className="cell-rating-rest">
            {"☆".repeat(Math.max(0, cell.max - cell.value))}
          </span>
        </span>
      );

    case "progress":
      return (
        <span className="cell-progress" title={cell.label}>
          <span className="cell-progress-track">
            <span className="cell-progress-fill" style={{ width: `${cell.percent}%` }} />
          </span>
          <span className="cell-progress-label">{cell.label}</span>
        </span>
      );
  }
}

function formatDate(iso: string, hasTime: boolean) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { label: "—", overdue: false };
  return {
    label: date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      ...dateFrame(hasTime),
    }),
    overdue: isOverdue(iso, hasTime),
  };
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function avatarColor(name: string) {
  const hues = [
    "var(--avatar-1)",
    "var(--avatar-2)",
    "var(--avatar-3)",
    "var(--avatar-4)",
    "var(--avatar-5)",
  ];
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hues[hash % hues.length];
}
