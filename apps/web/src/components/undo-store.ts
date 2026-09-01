"use client";

import { UndoStack, type Operation } from "@arbor/core";

/**
 * The undo stack lives at module scope, not in React state.
 *
 * Every mutation calls `revalidatePath("/")`, which re-renders the page and can
 * remount the provider — and a `useRef` holding the stack is reset when that
 * happens, so the history was silently emptied moments after being recorded.
 * Pressing undo then reported "Nothing to undo" even though the edit had
 * clearly just happened.
 *
 * Undo history belongs to the session, not to a component instance. Module
 * scope is what "the session" means on the client: it outlives every remount
 * and is cleared only by a full page load.
 */

const stack = new UndoStack(20);
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function recordInverse(inverse: readonly Operation[]): void {
  if (inverse.length === 0) return;
  stack.push(inverse);
  emit();
}

export function takeInverse(): Operation[] | undefined {
  const next = stack.pop();
  emit();
  return next;
}

export function undoDepth(): number {
  return stack.depth;
}

export function nextUndoDescription(): string | undefined {
  return stack.peekDescription();
}

/** Subscription plumbing for `useSyncExternalStore`. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Server snapshot — there is no undo history during SSR. */
export function serverDepth(): number {
  return 0;
}
