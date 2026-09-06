"use client";

import type { Operation, ResolvedColumn } from "@arbor/core";
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
}: {
  columns: ResolvedColumn[];
  rows: TableRowData[];
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
              >
                {column.label}
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
                  <span className="key">{row.key ?? "—"}</span>
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
      const due = formatDate(cell.iso);
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

function formatDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { label: "—", overdue: false };
  return {
    label: date.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
    overdue: date.getTime() < Date.now(),
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
