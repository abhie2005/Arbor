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
  type ReactNode,
} from "react";

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
  nextLabel: string | undefined;
}

const UndoContext = createContext<UndoContextValue | null>(null);

export function UndoProvider({ children }: { children: ReactNode }) {
  const depth = useSyncExternalStore(subscribe, undoDepth, serverDepth);
  const [toast, setToast] = useState<string | null>(null);

  const record = useCallback((inverse: readonly Operation[]) => {
    recordInverse(inverse);
  }, []);

  const undo = useCallback(() => {
    const inverse = takeInverse();

    if (!inverse) {
      setToast("Nothing to undo");
      return;
    }

    setToast(describeBatch(inverse));
    void undoAction(inverse);
  }, []);

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
    () => ({ record, undo, depth, nextLabel: nextUndoDescription() }),
    [record, undo, depth],
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
  const { undo, depth, nextLabel } = useUndo();

  return (
    <button
      type="button"
      className="undo-button"
      onClick={undo}
      disabled={depth === 0}
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
