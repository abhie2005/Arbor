import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/**
 * Ordering for anything a user can drag: tasks in a list, lists in a folder,
 * board columns, checklist items, view tabs.
 *
 * Positions are fractional index strings, not integers. With integers, dropping
 * a task at the top of a 500-row list rewrites 500 rows — every one of them a
 * realtime broadcast to every connected client. With fractional indices the same
 * drag writes exactly one row, and concurrent drags by two people converge
 * instead of fighting.
 *
 * The generation algorithm is subtle enough to be worth taking off the shelf;
 * this module is the domain-shaped wrapper around it. See
 * docs/decisions/0002-fractional-indexing.md.
 */

export type Position = string;

/**
 * A position between two neighbours. Pass null for an open end:
 * `positionBetween(null, first)` prepends, `positionBetween(last, null)` appends.
 */
export function positionBetween(before: Position | null, after: Position | null): Position {
  return generateKeyBetween(before ?? null, after ?? null);
}

/** The position for the first item in an empty collection. */
export function firstPosition(): Position {
  return generateKeyBetween(null, null);
}

/**
 * `count` evenly spaced positions between two neighbours — for pasting or
 * importing a batch without generating them one at a time, which would produce
 * ever-longer strings.
 */
export function positionsBetween(
  before: Position | null,
  after: Position | null,
  count: number,
): Position[] {
  if (count < 0) throw new RangeError("count must be >= 0");
  if (count === 0) return [];
  return generateNKeysBetween(before ?? null, after ?? null, count);
}

/** Sequential positions for a fresh collection, e.g. seeding or a template. */
export function initialPositions(count: number): Position[] {
  return positionsBetween(null, null, count);
}

/**
 * Move an item to `toIndex` within an ordered list, returning only the new
 * position. The caller writes one row.
 */
export function positionForMove(
  ordered: readonly Position[],
  fromIndex: number,
  toIndex: number,
): Position {
  if (fromIndex < 0 || fromIndex >= ordered.length) {
    throw new RangeError(`fromIndex ${fromIndex} out of range`);
  }
  if (toIndex < 0 || toIndex >= ordered.length) {
    throw new RangeError(`toIndex ${toIndex} out of range`);
  }

  const without = ordered.filter((_, i) => i !== fromIndex);
  const before = toIndex > 0 ? (without[toIndex - 1] ?? null) : null;
  const after = without[toIndex] ?? null;

  return positionBetween(before, after);
}

/** Ascending comparator. Positions sort lexicographically by construction. */
export function comparePositions(a: Position, b: Position): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Repeated insertions at the same spot grow the string without bound. Nothing
 * breaks, but a background job can rewrite a collection once a position gets
 * long. This is the signal to schedule that.
 */
export function needsRebalance(positions: readonly Position[], threshold = 48): boolean {
  return positions.some((p) => p.length > threshold);
}
