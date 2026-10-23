"use client";

import { type DueFormat, dueLabel, isOverdue } from "@arbor/core";

import { useHydrated } from "./use-hydrated";

/**
 * A due date, in a zone that was named rather than implied.
 *
 * **`Timestamp`'s fix (D-121), in the four places that print a due date**
 * (D-132). `task-row.tsx`, `board.tsx`, `task-table.tsx` and `task-detail.tsx`
 * each had their own `formatDue`/`formatDate` — two of them character for
 * character identical — spreading `dateFrame(hasTime)` into
 * `toLocaleDateString`. For a calendar day that spreads `timeZone: "UTC"` and
 * is right. For an instant it spreads `{}`, which means the ambient zone: the
 * server's during SSR and the viewer's in the browser, so the same stored
 * instant rendered `Thu 22` and then `Wed 21` and React threw the tree away.
 *
 * Nothing could see it until the seed had an instant in it (D-130), and then
 * the divergence was one `npm test` away.
 *
 * So, exactly as `Timestamp` does it:
 *
 * - **before hydration** an instant is pinned to UTC and *says* UTC, because a
 *   day with no zone beside it reads as the viewer's own and would be quietly
 *   wrong for the frame it is on screen;
 * - **after it**, the browser is the only thing rendering, so the label becomes
 *   the viewer's own day and the marker goes away.
 *
 * A **calendar day is untouched by all of this** and renders once, in UTC, on
 * both sides — which is what `dueHasTime: false` has meant since D-067 and why
 * every non-timed row in the app looks exactly as it did.
 *
 * **`overdue` follows the same split for a different reason.** For a calendar
 * day it is a UTC-day comparison, so the server and the browser agree and it is
 * rendered on both. For an instant it is a comparison against *the clock*, and
 * the server's clock is not the viewer's — so before hydration nothing claims
 * it, and the browser adds it on the render it is true for. One frame without
 * the red, against a mismatch on every timed row.
 */
export function DueDate({
  at,
  hasTime,
  format = "weekday",
  className,
  flagEmpty = false,
}: {
  at: string | null;
  hasTime: boolean;
  format?: DueFormat;
  className?: string;
  /**
   * Whether to emit `data-empty`. The list and the board style the dash; the
   * table and the detail page do not, and this keeps their markup as it was
   * rather than growing an attribute nothing reads.
   */
  flagEmpty?: boolean;
}) {
  const local = useHydrated();

  // `dueLabel` throws on a value that is not a date, like the rest of its
  // module. The table used to print a dash for one, so that guard stays here
  // rather than becoming a 500 on a corrupt column.
  const usable = at !== null && !Number.isNaN(new Date(at).getTime());

  if (!usable) {
    return (
      <span className={className} data-empty={flagEmpty ? true : undefined}>
        —
      </span>
    );
  }

  const pinned = hasTime && !local;

  return (
    <span
      className={className}
      data-overdue={hasTime ? (local ? isOverdue(at, true) : false) : isOverdue(at, false)}
      data-empty={flagEmpty ? false : undefined}
    >
      {dueLabel(at, hasTime, format, local ? undefined : "UTC")}
      {pinned ? " UTC" : ""}
    </span>
  );
}
