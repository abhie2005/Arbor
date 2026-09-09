import { describe, expect, it } from "vitest";

import {
  GoalError,
  type KeyResultKind,
  formatKeyResultValue,
  goalProgress,
  keyResultProgress,
  parseCurrency,
  parseKeyResultValue,
  parseRollupSource,
  serializeKeyResultValue,
} from "./goals";

function kr(patch: Partial<{ kind: KeyResultKind; start: number; target: number; current: number | null }> = {}) {
  return { kind: "number" as KeyResultKind, start: 0, target: 10, current: 5, ...patch };
}

describe("parseKeyResultValue", () => {
  it("reads a number out of the text column it lives in", () => {
    expect(parseKeyResultValue("number", "42")).toBe(42);
    expect(parseKeyResultValue("currency", "1500.5")).toBe(1500.5);
  });

  it("treats an empty column as no value rather than as zero", () => {
    // A rollup that has not been resolved is empty; zero would be a claim.
    expect(parseKeyResultValue("number", "")).toBeNull();
    expect(parseKeyResultValue("number", null)).toBeNull();
  });

  it("accepts what a checkbox posts as well as what the column holds", () => {
    expect(parseKeyResultValue("boolean", "true")).toBe(1);
    expect(parseKeyResultValue("boolean", false)).toBe(0);
  });

  it("refuses text that is not a number, rather than storing NaN", () => {
    expect(() => parseKeyResultValue("number", "soon")).toThrow(GoalError);
  });

  it("round-trips through the column", () => {
    for (const kind of ["number", "currency", "boolean"] as const) {
      const value = kind === "boolean" ? 1 : 7;
      expect(parseKeyResultValue(kind, serializeKeyResultValue(kind, value))).toBe(value);
    }
  });
});

describe("keyResultProgress", () => {
  it("is the fraction of the distance travelled", () => {
    expect(keyResultProgress(kr({ start: 0, target: 10, current: 5 }))).toBe(0.5);
  });

  it("starts from the start, not from zero", () => {
    // "Grow revenue from 80 to 100" is a fifth done at 84, not 84% done.
    expect(keyResultProgress(kr({ start: 80, target: 100, current: 84 }))).toBeCloseTo(0.2);
  });

  it("handles a target below the start without a special case", () => {
    // "Reduce open bugs from 50 to 10": both halves change sign together.
    expect(keyResultProgress(kr({ start: 50, target: 10, current: 30 }))).toBe(0.5);
  });

  it("goes past one rather than clamping", () => {
    // Passing a target is the most interesting thing this number can say.
    expect(keyResultProgress(kr({ start: 0, target: 10, current: 25 }))).toBe(2.5);
  });

  it("is null when nothing has been measured yet", () => {
    expect(keyResultProgress(kr({ current: null }))).toBeNull();
  });

  it("is null when the target asks for no movement", () => {
    expect(keyResultProgress(kr({ start: 5, target: 5, current: 5 }))).toBeNull();
  });

  it("is all or nothing for a yes/no", () => {
    expect(keyResultProgress(kr({ kind: "boolean", current: 1 }))).toBe(1);
    expect(keyResultProgress(kr({ kind: "boolean", current: 0 }))).toBe(0);
  });
});

describe("goalProgress", () => {
  it("is the mean of its key results", () => {
    expect(goalProgress([kr({ current: 10 }), kr({ current: 0 })])).toBe(0.5);
  });

  it("clamps each one before averaging", () => {
    // Otherwise one key result at 300% carries two that have not started, and
    // the goal reports done while two thirds of it is untouched.
    expect(goalProgress([kr({ current: 30 }), kr({ current: 0 }), kr({ current: 0 })])).toBeCloseTo(
      1 / 3,
    );
  });

  it("ignores the ones that cannot be measured", () => {
    expect(goalProgress([kr({ current: 10 }), kr({ current: null })])).toBe(1);
  });

  it("is null for a goal that is only a title", () => {
    expect(goalProgress([])).toBeNull();
    expect(goalProgress([kr({ current: null })])).toBeNull();
  });
});

describe("parseRollupSource", () => {
  const good = {
    scope: { kind: "list", id: "l1" },
    definition: { filters: {} },
    aggregate: { fn: "count" },
  };

  it("accepts a source that says what it counts and where", () => {
    expect(parseRollupSource(good).aggregate.fn).toBe("count");
  });

  it("refuses an aggregate nobody declared", () => {
    // The blob is client input, so a function name must never reach the query
    // as text.
    expect(() => parseRollupSource({ ...good, aggregate: { fn: "drop" } })).toThrow(GoalError);
  });

  it("refuses a sum with nothing to total", () => {
    expect(() => parseRollupSource({ ...good, aggregate: { fn: "sum" } })).toThrow(/field/);
  });

  it("refuses a source with no filter or no scope", () => {
    expect(() => parseRollupSource({ ...good, definition: undefined })).toThrow(GoalError);
    expect(() => parseRollupSource({ ...good, scope: undefined })).toThrow(GoalError);
    expect(() => parseRollupSource(null)).toThrow(GoalError);
  });
});

describe("formatting", () => {
  it("renders a currency in its own code", () => {
    expect(formatKeyResultValue("currency", 1500, { currency: "GBP" })).toContain("1,500");
  });

  it("falls back rather than taking the screen down on a bad code", () => {
    expect(() => parseCurrency({ currency: "pounds" })).toThrow(GoalError);
    expect(formatKeyResultValue("currency", 12, { currency: "pounds" })).toBe("12");
  });

  it("says done rather than 1", () => {
    expect(formatKeyResultValue("boolean", 1)).toBe("Done");
    expect(formatKeyResultValue("boolean", 0)).toBe("Not done");
  });

  it("shows an unmeasured rollup as nothing, not as zero", () => {
    expect(formatKeyResultValue("rollup", null)).toBe("—");
  });

  it("keeps whole numbers whole", () => {
    expect(formatKeyResultValue("number", 7)).toBe("7");
    expect(formatKeyResultValue("number", 7.25)).toBe("7.3");
  });
});
