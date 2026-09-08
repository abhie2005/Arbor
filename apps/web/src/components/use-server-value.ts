"use client";

import { type Dispatch, type SetStateAction, useState } from "react";

/**
 * A value you may edit optimistically, that still follows the server.
 *
 * `useState(task.name)` reads as "start from the server's value", and it is
 * really "take the server's value once and never look again". That was
 * invisible while the only thing that changed a name was the person looking at
 * it — their own optimistic value was already correct. Live updates made it
 * visible immediately: a rename by somebody else re-rendered the row with the
 * new name and the screen kept the old one, with no error anywhere (D-090).
 *
 * So the rule is the one `useTaskAction` already follows for failures — the
 * server is authoritative — applied to arrivals as well as refusals.
 *
 * `hold` is for the moment when it is not: while someone is typing into the
 * field, their draft wins. A live update during those few seconds is dropped
 * rather than yanking the caret, and the next one after they stop lands
 * normally.
 *
 * Adjusting state during render rather than in an effect is deliberate — it is
 * React's own answer for "reset state when a prop changes", and it re-renders
 * before the browser paints instead of after, so the stale value is never
 * visible.
 */
export function useServerValue<T>(
  server: T,
  hold = false,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(server);
  const [seen, setSeen] = useState(server);

  if (server !== seen) {
    setSeen(server);
    if (!hold) setValue(server);
  }

  return [value, setValue];
}
