import { describe, expect, it } from "vitest";

import {
  comparePositions,
  firstPosition,
  initialPositions,
  needsRebalance,
  positionBetween,
  positionForMove,
  positionsBetween,
} from "./ordering";

describe("ordering", () => {
  it("generates a position for an empty collection", () => {
    expect(firstPosition()).toBeTypeOf("string");
  });

  it("sorts a prepend before the existing first item", () => {
    const first = firstPosition();
    const before = positionBetween(null, first);
    expect(comparePositions(before, first)).toBe(-1);
  });

  it("sorts an append after the existing last item", () => {
    const first = firstPosition();
    const after = positionBetween(first, null);
    expect(comparePositions(first, after)).toBe(-1);
  });

  it("always lands strictly between two neighbours", () => {
    const [a, b] = initialPositions(2) as [string, string];
    const mid = positionBetween(a, b);
    expect(comparePositions(a, mid)).toBe(-1);
    expect(comparePositions(mid, b)).toBe(-1);
  });

  it("survives repeated insertion at the same point", () => {
    // The pathological drag: always drop into the same gap.
    let low = firstPosition();
    const high = positionBetween(low, null);

    for (let i = 0; i < 200; i++) {
      const mid = positionBetween(low, high);
      expect(comparePositions(low, mid)).toBe(-1);
      expect(comparePositions(mid, high)).toBe(-1);
      low = mid;
    }
  });

  it("generates n ordered positions in one call", () => {
    const positions = positionsBetween(null, null, 5);
    expect(positions).toHaveLength(5);
    expect([...positions].sort()).toEqual(positions);
  });

  it("returns an empty array for zero", () => {
    expect(positionsBetween(null, null, 0)).toEqual([]);
  });

  it("rejects a negative count", () => {
    expect(() => positionsBetween(null, null, -1)).toThrow(RangeError);
  });

  describe("positionForMove", () => {
    const ordered = initialPositions(4);

    it("moves an item to the front", () => {
      const next = positionForMove(ordered, 2, 0);
      expect(comparePositions(next, ordered[0]!)).toBe(-1);
    });

    it("moves an item to the back", () => {
      const next = positionForMove(ordered, 0, 3);
      expect(comparePositions(ordered[3]!, next)).toBe(-1);
    });

    it("moves an item into the middle", () => {
      // Dragging index 0 to index 2: it lands between the old 2nd and 3rd items.
      const next = positionForMove(ordered, 0, 2);
      expect(comparePositions(ordered[2]!, next)).toBe(-1);
      expect(comparePositions(next, ordered[3]!)).toBe(-1);
    });

    it("rejects out-of-range indices", () => {
      expect(() => positionForMove(ordered, 9, 0)).toThrow(RangeError);
      expect(() => positionForMove(ordered, 0, 9)).toThrow(RangeError);
    });
  });

  it("flags a collection that has drifted long enough to rebalance", () => {
    expect(needsRebalance(initialPositions(3))).toBe(false);
    expect(needsRebalance(["a".repeat(60)])).toBe(true);
  });
});
