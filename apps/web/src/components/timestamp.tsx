"use client";

import { instantDay, instantStamp } from "@arbor/core";

import { relative } from "./relative-time";
import { useHydrated } from "./use-hydrated";

/**
 * When something happened.
 *
 * **Two renders, because an instant has two correct answers and only one of
 * them can be the server's** (D-121). The rule in `packages/core/src/dates.ts`
 * is that an instant is read in the viewer's zone; a server render has no
 * viewer, so it read in the server's, and React compared the two renders of the
 * same `<time>` and threw the tree away — "10 Oct" from a UTC container against
 * "9 Oct" in a Pacific browser, with the mismatch printed in the console of
 * every deployment where the two differ, which is nearly all of them.
 *
 * `suppressHydrationWarning` was the obvious fix and the wrong one: it silences
 * the report and keeps the re-render. Pinning everything to UTC was the other,
 * and it would have shown every reader a time nobody asked for.
 *
 * So:
 *
 * - **before hydration** the frame is pinned to UTC and labelled as UTC, which
 *   is the one answer a server and a browser can both produce. The line reads
 *   as a short day rather than as nothing, so the row has its final width;
 * - **after it**, the browser is the only thing rendering and the viewer's own
 *   zone and clock are both available, so the line becomes the relative time
 *   this component is really for and the tooltip becomes their local time.
 *
 * The swap happens in an effect, which means it happens after paint — late
 * enough that the first render is what hydration compares against, and early
 * enough that nobody reads the pinned value. `relative` is called from the
 * second render only, which is what makes its `Date.now()` sound: the server's
 * clock and the browser's are never compared, because the server never calls
 * it.
 */
export function Timestamp({
  at,
  className,
}: {
  at: string;
  className?: string;
}) {
  const local = useHydrated();

  return (
    <time
      className={className}
      dateTime={at}
      title={local ? instantStamp(at) : instantStamp(at, "UTC")}
    >
      {local ? relative(at) : instantDay(at, "UTC")}
    </time>
  );
}
