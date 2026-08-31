"use client";

import { type Operation, UndoStack, describeBatch } from "@arbor/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { undo as undoAction } from "@/server/actions";

/**
 * The undo stack lives in the client, holding inverse operations the server
 * returned.
 *
 * The server decides what the inverse is (it knows the previous value; a stale
 * tab does not), and the client only decides *when* to apply it. That split is
 * what keeps undo correct when two people are editing the same list.
 */

interface UndoContextValue {
  record: (inverse: Operation[]) => void;
  undo: () => void;
  depth: number;
  pending: string | null;
}

const UndoContext = createContext<UndoContextValue | null>(null);

export function UndoProvider({ children }: { children: ReactNode }) {
  const stack = useRef(new UndoStack(20));
  const [depth, setDepth] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const record = useCallback((inverse: Operation[]) => {
    if (inverse.length === 0) return;
    stack.current.push(inverse);
    setDepth(stack.current.depth);
  }, []);

  const undo = useCallback(() => {
    const inverse = stack.current.pop();
    setDepth(stack.current.depth);

    if (!inverse) {
      setToast("Nothing to undo");
      return;
    }

    setToast(describeBatch(inverse));
    void undoAction(inverse);
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      // Single-letter and modifier shortcuts must never fire while the user is
      // typing — the most common keyboard-UI bug there is.
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (typing) return;

      if ((event.metaKey || event.ctrlKey) && event.key === "z") {
        event.preventDefault();
        undo();
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const value = useMemo(
    () => ({ record, undo, depth, pending: toast }),
    [record, undo, depth, toast],
  );

  return (
    <UndoContext.Provider value={value}>
      {children}
      {toast ? (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button type="button" onClick={undo} disabled={depth === 0}>
            Undo <kbd>⌘Z</kbd>
          </button>
        </div>
      ) : null}
    </UndoContext.Provider>
  );
}

export function useUndo(): UndoContextValue {
  const context = useContext(UndoContext);
  if (!context) throw new Error("useUndo must be used inside <UndoProvider>");
  return context;
}
