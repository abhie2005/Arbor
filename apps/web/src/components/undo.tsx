"use client";

import { describeBatch, type Operation } from "@arbor/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

import { undo as undoAction } from "@/server/actions";

import {
  nextUndoDescription,
  recordInverse,
  serverDepth,
  subscribe,
  takeInverse,
  undoDepth,
} from "./undo-store";

/**
 * Undo, driven by inverse operations the server returned.
 *
 * The server decides what the inverse is — it knows the previous value, and a
 * tab that has been open for ten minutes does not. The client decides only when
 * to apply it.
 *
 * The stack itself lives in `undo-store`, at module scope, because every
 * mutation revalidates the page and a remount would wipe component-local state.
 */

interface UndoContextValue {
  record: (inverse: readonly Operation[]) => void;
  undo: () => void;
  depth: number;
  pending: boolean;
  nextLabel: string | undefined;
}

const UndoContext = createContext<UndoContextValue | null>(null);

export function UndoProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const depth = useSyncExternalStore(subscribe, undoDepth, serverDepth);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const record = useCallback((inverse: readonly Operation[]) => {
    recordInverse(inverse);
  }, []);

  const undo = useCallback(() => {
    const inverse = takeInverse();

    if (!inverse) {
      setToast("Nothing to undo");
      return;
    }

    // Inside a transition, and awaited. Both matter:
    //
    //   - Outside a transition, Next.js never applies the refreshed page
    //     payload that `revalidatePath` produces, so the write lands in the
    //     database and the screen keeps showing stale rows.
    //   - Fire-and-forget meant the toast claimed success before the server had
    //     answered, so a failed undo still reported that it had worked.
    startTransition(async () => {
      try {
        await undoAction(inverse);
        // Belt and braces: force the server components to re-fetch even if the
        // action's own revalidation did not reach this tree.
        router.refresh();
        setToast(describeBatch(inverse));
      } catch (error) {
        // Put it back — a failed undo must not cost the user their history.
        recordInverse(inverse);
        setToast(
          error instanceof Error ? `Undo failed — ${error.message}` : "Undo failed",
        );
      }
    });
  }, [router]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      // toLowerCase because Shift or Caps Lock yields "Z".
      if (event.key.toLowerCase() !== "z") return;

      // Never hijack undo while the user is typing — the browser's own text
      // undo is what they mean there.
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }

      event.preventDefault();
      undo();
    }

    // Capture phase: nothing downstream gets to swallow the shortcut first.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [undo]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const value = useMemo(
    () => ({ record, undo, depth, pending, nextLabel: nextUndoDescription() }),
    [record, undo, depth, pending],
  );

  return (
    <UndoContext.Provider value={value}>
      {children}
      {toast ? (
        <div className="toast" role="status">
          <span>{toast}</span>
          {depth > 0 ? (
            <button type="button" onClick={undo}>
              Undo again <kbd>⌘Z</kbd>
            </button>
          ) : null}
        </div>
      ) : null}
    </UndoContext.Provider>
  );
}

/**
 * A visible control, so undo does not depend on knowing a shortcut — and so
 * the stack depth is observable rather than something you infer from behaviour.
 */
export function UndoButton() {
  const { undo, depth, pending, nextLabel } = useUndo();

  return (
    <button
      type="button"
      className="undo-button"
      onClick={undo}
      disabled={depth === 0 || pending}
      title={depth > 0 ? `${nextLabel} · ⌘Z` : "Nothing to undo"}
    >
      <span aria-hidden>↩</span> Undo
      {depth > 0 ? <span className="undo-depth">{depth}</span> : null}
    </button>
  );
}

export function useUndo(): UndoContextValue {
  const context = useContext(UndoContext);
  if (!context) throw new Error("useUndo must be used inside <UndoProvider>");
  return context;
}
