"use client";

import type { Operation } from "@arbor/core";
import { useEffect, useState, useTransition } from "react";

import { useUndo } from "./undo";

/**
 * Running a mutation from a control, the same way everywhere.
 *
 * Four behaviours travel together and each one was a bug before it was a rule:
 * the call runs inside a transition and is awaited (D-040); its inverse is
 * pushed onto the undo stack exactly as the server returned it (D-049); a
 * failure is shown rather than swallowed; and the control reverts to the
 * server's value instead of keeping the rejected one (D-053).
 *
 * Extracted when the table arrived. A second renderer with its own copy of
 * that list is a second place for one of them to go missing, and the one that
 * goes missing quietly is the last: a control that keeps a value the server
 * refused looks exactly like a control that worked.
 */
export function useTaskAction() {
  const { record } = useUndo();
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!failure) return;
    const timer = setTimeout(() => setFailure(null), 4000);
    return () => clearTimeout(timer);
  }, [failure]);

  /**
   * `revert` puts an optimistic control back to what the server still holds.
   * It runs before the message is shown, so the row never displays a refused
   * value alongside the reason it was refused.
   */
  function run(action: () => Promise<Operation[]>, revert?: () => void) {
    startTransition(async () => {
      try {
        record(await action());
      } catch (error) {
        revert?.();
        setFailure(error instanceof Error ? error.message : "That change did not save");
      }
    });
  }

  return { run, pending, failure };
}
