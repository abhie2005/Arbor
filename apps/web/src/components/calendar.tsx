"use client";

import { type Operation, addMonths, monthOf, utcDayKey } from "@arbor/core";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useOptimistic, useState } from "react";

import { setTaskDate } from "@/server/actions";

import { useTaskAction } from "./use-task-action";

/**
 * The month renderer.
 *
 * The first view whose shape is not a sequence of rows, and the interesting
 * thing is how little that changed. It runs the same compiled query as every
 * other renderer with one condition appended — the date field falls inside the
 * six weeks on screen — which the compiler already expressed as `between`. No
 * new SQL, no grouping by day in the database: a month is at most a few hundred
 * rows and putting each one in a square is arithmetic, not a query.
 *
 * Dragging follows the board (D-051, D-052): native HTML5 drag, the payload on
 * `dataTransfer` rather than in React state, and the move applied optimistically
 * so the chip lands in the square under the cursor rather than a round trip
 * later.
 */

export interface CalendarTask {
  id: string;
  key: string | null;
  name: string;
  /** The day this sits on, `YYYY-MM-DD`, decided on the server (D-067). */
  day: string;
  statusGroup: string | null;
  priority: number | null;
  overdue: boolean;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function Calendar({
  month,
  weeks,
  tasks,
  dateField,
  today,
}: {
  month: string;
  weeks: string[][];
  tasks: CalendarTask[];
  /** Which date the squares mean, and therefore which one a drag moves. */
  dateField: "dueAt" | "startAt";
  /** Resolved on the server so the grid does not shift when the client renders. */
  today: string;
}) {
  const { run, pending, failure } = useTaskAction();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  // The chip moves on drop and reconciles when the server answers, so a
  // refused move snaps back without this component keeping its own copy.
  const [shown, moveOptimistically] = useOptimistic(
    tasks,
    (current: CalendarTask[], move: { id: string; day: string }) =>
      current.map((task) => (task.id === move.id ? { ...task, day: move.day } : task)),
  );

  const byDay = new Map<string, CalendarTask[]>();
  for (const task of shown) {
    byDay.set(task.day, [...(byDay.get(task.day) ?? []), task]);
  }

  function drop(day: string, event: React.DragEvent) {
    event.preventDefault();
    setOver(null);
    setDragging(null);

    // Read from dataTransfer, never from state: dragstart and drop are separate
    // commits, and a drop arriving first would read null and do nothing (D-052).
    const id = event.dataTransfer.getData("text/arbor-task");
    if (!id) return;

    const task = shown.find((candidate) => candidate.id === id);
    if (!task || task.day === day) return;

    moveOptimistically({ id, day });
    run(() => setTaskDate(id, dateField, day) as Promise<Operation[]>);
  }

  return (
    <div className="calendar" data-pending={pending || undefined}>
      <MonthBar month={month} />

      {failure ? (
        <p className="calendar-error" role="alert">
          {failure}
        </p>
      ) : null}

      <div className="calendar-grid">
        {WEEKDAYS.map((day) => (
          <div className="calendar-weekday" key={day}>
            {day}
          </div>
        ))}

        {weeks.flat().map((day) => {
          const inMonth = day.startsWith(month);
          const dayTasks = byDay.get(day) ?? [];

          return (
            <div
              className="calendar-day"
              key={day}
              data-outside={!inMonth || undefined}
              data-today={day === today || undefined}
              data-over={over === day || undefined}
              onDragOver={(event) => {
                // Without preventDefault the browser refuses the drop, which
                // looks exactly like a handler that is not wired up.
                event.preventDefault();
                setOver(day);
              }}
              onDragLeave={() => setOver((current) => (current === day ? null : current))}
              onDrop={(event) => drop(day, event)}
            >
              <div className="calendar-date">
                {day === today ? <span className="calendar-today-mark" /> : null}
                {Number(day.slice(8))}
              </div>

              {dayTasks.map((task) => (
                <div
                  className="calendar-chip"
                  key={task.id}
                  draggable
                  data-dragging={dragging === task.id || undefined}
                  data-overdue={task.overdue || undefined}
                  title={`${task.key ? `${task.key} · ` : ""}${task.name}`}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/arbor-task", task.id);
                    event.dataTransfer.effectAllowed = "move";
                    setDragging(task.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                >
                  <span className="dot" data-group={task.statusGroup ?? undefined} />
                  <span className="calendar-chip-name">{task.name}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Month navigation, as links.
 *
 * Same argument as the sortable headers (D-065): a month is an address, so it
 * belongs in the URL, works before hydration, and lands in history — paging
 * three months forward and pressing back should return you two, not to
 * whatever page you were on before the calendar.
 */
function MonthBar({ month }: { month: string }) {
  const pathname = usePathname();
  const params = useSearchParams();

  const href = (target: string) => {
    const query = new URLSearchParams(params.toString());
    query.set("m", target);
    return `${pathname}?${query.toString()}`;
  };

  const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="calendar-bar">
      <Link className="calendar-step" href={href(addMonths(month, -1))} aria-label="Previous month">
        ‹
      </Link>
      <span className="calendar-month">{label}</span>
      <Link className="calendar-step" href={href(addMonths(month, 1))} aria-label="Next month">
        ›
      </Link>
      <Link className="calendar-today" href={href(monthOf(utcDayKey(new Date())))}>
        Today
      </Link>
    </div>
  );
}
