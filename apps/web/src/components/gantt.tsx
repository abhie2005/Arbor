"use client";

import { addMonths, monthOf, utcDayKey } from "@arbor/core";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * The timeline renderer.
 *
 * The renderer STATUS expected to break the compiler bet, and it half did. The
 * rows are the same compiled query as everything else — but "overlaps this
 * window" could not be expressed, because a `FilterGroup` was a flat list
 * joined by one operator and the question is
 * `(start IS NULL OR start <= end) AND (due IS NULL OR due >= begin)`. So the
 * compiler learned to nest clauses, and the timeline runs the ordinary query
 * with a nested scope appended (D-068). No new SQL, no second query, no join.
 *
 * Drawing is arithmetic on day keys: a bar starts at the column of its start
 * date and ends at the column of its due date, clamped to the window.
 */

export interface GanttBar {
  id: string;
  key: string | null;
  name: string;
  /** Day keys, already resolved on the server (D-067). Either may be absent. */
  startDay: string | null;
  dueDay: string | null;
  statusGroup: string | null;
  overdue: boolean;
}

export function Gantt({
  month,
  days,
  bars,
  today,
}: {
  month: string;
  days: string[];
  bars: GanttBar[];
  today: string;
}) {
  return (
    <div className="gantt">
      <MonthBar month={month} />

      {bars.length === 0 ? (
        <p className="gantt-empty" role="status">
          Nothing scheduled in this month. A task appears here once it has a start or a due date.
        </p>
      ) : (
        <div className="gantt-scroll">
          <div
            className="gantt-grid"
            style={{ gridTemplateColumns: `220px repeat(${days.length}, minmax(26px, 1fr))` }}
          >
            <div className="gantt-corner" />
            {days.map((day) => (
              <div
                className="gantt-heading"
                key={day}
                data-today={day === today || undefined}
                data-weekend={isWeekend(day) || undefined}
              >
                {Number(day.slice(8))}
              </div>
            ))}

            {bars.map((bar) => {
              const span = spanOf(bar, days);

              return (
                <Row key={bar.id} bar={bar} span={span} days={days} today={today} />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  bar,
  span,
  days,
  today,
}: {
  bar: GanttBar;
  span: { from: number; to: number; openStart: boolean; openEnd: boolean } | null;
  days: string[];
  today: string;
}) {
  return (
    <>
      <div className="gantt-name" title={`${bar.key ? `${bar.key} · ` : ""}${bar.name}`}>
        <span className="dot" data-group={bar.statusGroup ?? undefined} />
        <span className="gantt-name-text">{bar.name}</span>
      </div>

      {days.map((day, index) => (
        <div
          className="gantt-cell"
          key={day}
          data-today={day === today || undefined}
          data-weekend={isWeekend(day) || undefined}
        >
          {span && index === span.from ? (
            <span
              className="gantt-bar"
              // Spanning by width rather than by grid column, so the bar sits
              // inside the row's cells and does not need its own grid track.
              style={{ width: `calc(${span.to - span.from + 1} * 100% + ${span.to - span.from} * 1px)` }}
              data-group={bar.statusGroup ?? undefined}
              data-overdue={bar.overdue || undefined}
              data-open-start={span.openStart || undefined}
              data-open-end={span.openEnd || undefined}
            />
          ) : null}
        </div>
      ))}
    </>
  );
}

/**
 * Which columns a bar covers.
 *
 * A task with only one of the two dates is a single day rather than a bar
 * running to the edge of the screen: "starts on the 4th, no deadline" is not
 * the same claim as "runs from the 4th to the end of the month", and drawing
 * the second would be inventing a date nobody set. The open end is marked so
 * the cell can show it is unbounded rather than finished.
 */
function spanOf(
  bar: GanttBar,
  days: string[],
): { from: number; to: number; openStart: boolean; openEnd: boolean } | null {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return null;

  const start = bar.startDay ?? bar.dueDay;
  const end = bar.dueDay ?? bar.startDay;
  if (!start || !end) return null;

  // Clamped to the window: a bar that began last month starts at column zero
  // and is marked as continuing off the left edge.
  const clampedStart = start < first ? first : start;
  const clampedEnd = end > last ? last : end;
  if (clampedStart > last || clampedEnd < first) return null;

  const from = days.indexOf(clampedStart);
  const to = days.indexOf(clampedEnd);
  if (from < 0 || to < 0) return null;

  return {
    from,
    to: Math.max(from, to),
    openStart: start < first,
    openEnd: end > last || (bar.dueDay === null && bar.startDay !== null),
  };
}

function isWeekend(day: string): boolean {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/** Month navigation, as links — the same argument as the calendar's (D-065). */
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
        &#8249;
      </Link>
      <span className="calendar-month">{label}</span>
      <Link className="calendar-step" href={href(addMonths(month, 1))} aria-label="Next month">
        &#8250;
      </Link>
      <Link className="calendar-today" href={href(monthOf(utcDayKey(new Date())))}>
        Today
      </Link>
    </div>
  );
}
