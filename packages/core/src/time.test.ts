import { describe, expect, it } from "vitest";

import {
  TimeEntryInvalid,
  type TimeEntryValues,
  entryDurationMs,
  formatClock,
  formatDuration,
  isRunning,
  sameTimeEntry,
  trackedPercent,
  validateTimeEntry,
} from "./time";

const NOW = new Date("2026-09-09T12:00:00.000Z");

function entry(patch: Partial<TimeEntryValues> = {}): TimeEntryValues {
  return {
    startedAt: new Date("2026-09-09T10:00:00.000Z"),
    endedAt: new Date("2026-09-09T11:30:00.000Z"),
    description: null,
    isBillable: false,
    ...patch,
  };
}

describe("isRunning", () => {
  it("is the endedAt column and nothing else", () => {
    expect(isRunning(entry({ endedAt: null }))).toBe(true);
    expect(isRunning(entry())).toBe(false);
  });
});

describe("entryDurationMs", () => {
  it("measures a finished entry between its own instants", () => {
    expect(entryDurationMs(entry(), NOW)).toBe(90 * 60_000);
  });

  it("measures a running entry against now, having written nothing", () => {
    expect(entryDurationMs(entry({ endedAt: null }), NOW)).toBe(120 * 60_000);
  });

  it("never returns a negative, whatever the clock says", () => {
    // The server renders once and the browser keeps counting; a viewer whose
    // clock is behind the server's must not see a timer running backwards.
    const behind = new Date("2026-09-09T09:00:00.000Z");
    expect(entryDurationMs(entry({ endedAt: null }), behind)).toBe(0);
  });
});

describe("validateTimeEntry", () => {
  it("accepts a running entry with no end", () => {
    expect(() => validateTimeEntry(entry({ endedAt: null }), NOW)).not.toThrow();
  });

  it("refuses an entry that ends before it starts", () => {
    const backwards = entry({ endedAt: new Date("2026-09-09T09:00:00.000Z") });
    expect(() => validateTimeEntry(backwards, NOW)).toThrow(TimeEntryInvalid);
  });

  it("refuses a zero-length entry", () => {
    const instant = entry({ endedAt: new Date("2026-09-09T10:00:00.000Z") });
    expect(() => validateTimeEntry(instant, NOW)).toThrow(TimeEntryInvalid);
  });

  it("refuses a start in the future", () => {
    const later = entry({ startedAt: new Date("2026-09-10T10:00:00.000Z"), endedAt: null });
    expect(() => validateTimeEntry(later, NOW)).toThrow(/future/);
  });

  it("tolerates a start a few seconds ahead, because two clocks disagree", () => {
    // Postgres runs in a VM here and drifts tens of milliseconds either way. A
    // timer started this instant must not be refused for it.
    const skewed = entry({ startedAt: new Date(NOW.getTime() + 20_000), endedAt: null });
    expect(() => validateTimeEntry(skewed, NOW)).not.toThrow();
  });

  it("refuses a date that is not one, rather than summing NaN later", () => {
    const broken = entry({ startedAt: new Date("nonsense") });
    expect(() => validateTimeEntry(broken, NOW)).toThrow(TimeEntryInvalid);
  });

  it("accepts an entry left running over a weekend", () => {
    // No maximum length on purpose: the honest answer to a forgotten timer is a
    // long entry somebody can correct, not a refusal or a silent truncation.
    const friday = entry({ startedAt: new Date("2026-09-04T17:00:00.000Z"), endedAt: null });
    expect(() => validateTimeEntry(friday, NOW)).not.toThrow();
  });
});

describe("sameTimeEntry", () => {
  it("compares instants by value, not by object identity", () => {
    expect(sameTimeEntry(entry(), entry())).toBe(true);
  });

  it("treats a null description and an empty one as the same", () => {
    expect(sameTimeEntry(entry({ description: null }), entry({ description: "" }))).toBe(true);
  });

  it("sees a changed end", () => {
    const later = entry({ endedAt: new Date("2026-09-09T11:31:00.000Z") });
    expect(sameTimeEntry(entry(), later)).toBe(false);
  });

  it("sees the billable flag", () => {
    expect(sameTimeEntry(entry(), entry({ isBillable: true }))).toBe(false);
  });
});

describe("formatDuration", () => {
  it("reads hours and minutes together", () => {
    expect(formatDuration(90 * 60_000)).toBe("1h 30m");
  });

  it("drops the minutes when there are none", () => {
    expect(formatDuration(2 * 3_600_000)).toBe("2h");
  });

  it("drops the hours when there are none", () => {
    expect(formatDuration(45 * 60_000)).toBe("45m");
  });

  it("floors to the minute rather than rounding up to one", () => {
    // Thirty seconds of tracked time is not a minute of work, and a timesheet
    // that rounds every stray click up is one that always overstates.
    expect(formatDuration(30_000)).toBe("0m");
  });

  it("never renders a negative", () => {
    expect(formatDuration(-5_000)).toBe("0m");
  });
});

describe("formatClock", () => {
  it("shows seconds, because a readout that does not move looks stopped", () => {
    expect(formatClock(3600_000 + 23 * 60_000 + 45_000)).toBe("1:23:45");
  });

  it("pads minutes and seconds but not hours", () => {
    expect(formatClock(5_000)).toBe("0:00:05");
    expect(formatClock(100 * 3_600_000)).toBe("100:00:00");
  });
});

describe("trackedPercent", () => {
  it("is null when there is no estimate to compare against", () => {
    expect(trackedPercent(3_600_000, null)).toBeNull();
    expect(trackedPercent(3_600_000, 0)).toBeNull();
  });

  it("reports the fraction of the estimate used", () => {
    expect(trackedPercent(3_600_000, 7_200_000)).toBe(50);
  });

  it("goes past a hundred rather than clamping", () => {
    // Over an estimate is the most useful thing this number ever says, and a
    // bar that stops at 100% hides exactly the tasks worth looking at.
    expect(trackedPercent(14_400_000, 7_200_000)).toBe(200);
  });
});
