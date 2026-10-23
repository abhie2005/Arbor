"use client";

import { useEffect, useState } from "react";

/**
 * False while the server's markup is what is on screen, true once this is the
 * browser's own render.
 *
 * The state update in an effect with no dependencies is the point rather than
 * an oversight: it cannot run on the server, and it runs exactly once per mount
 * in the browser. `useServerValue`'s during-render adjustment is the opposite
 * case — there the stale value must never be painted, here it must be, because
 * hydration has to see the markup it was given.
 *
 * Lives in its own module because two components need it now: `Timestamp`,
 * which it was written for (D-121), and `DueDate`, which is the same fix in the
 * four places that print a due date (D-132).
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
