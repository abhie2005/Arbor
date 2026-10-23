import { describe, expect, it } from "vitest";

import {
  addMonths,
  addUtcDays,
  dayKeyFor,
  daysOfMonth,
  dueLabel,
  instantDay,
  instantStamp,
  isMonth,
  isOverdue,
  monthBounds,
  monthGrid,
  monthOf,
  monthRange,
  startOfUtcDay,
  utcDayKey,
} from "./dates";

describe("a calendar day is not an instant", () => {
  // The bug this module exists for: a date-only value stored at 03:12 UTC and
  // read in a western zone is the previous day, so the table said the 3rd about
  // a task stored on the 4th.
  it("reads a date-only value in UTC, whatever zone the reader is in", () => {
    const stored = "2026-09-04T03:12:11.034Z";
    expect(dayKeyFor(stored, false, "America/Los_Angeles")).toBe("2026-09-04");
    expect(dayKeyFor(stored, false, "Asia/Tokyo")).toBe("2026-09-04");
  });

  it("reads an instant in the zone it is read in, because that is what it means", () => {
    const stored = "2026-09-04T03:12:11.034Z";
    expect(dayKeyFor(stored, true, "America/Los_Angeles")).toBe("2026-09-03");
    expect(dayKeyFor(stored, true, "Asia/Tokyo")).toBe("2026-09-04");
  });

  it("normalizes a day to midnight UTC", () => {
    expect(startOfUtcDay("2026-09-04T23:59:59Z").toISOString()).toBe("2026-09-04T00:00:00.000Z");
  });

  it("adds days across a month boundary", () => {
    expect(utcDayKey(addUtcDays("2026-09-30", 1))).toBe("2026-10-01");
    expect(utcDayKey(addUtcDays("2026-03-01", -1))).toBe("2026-02-28");
  });
});

describe("overdue", () => {
  const now = new Date("2026-09-05T12:00:00Z");

  it("does not call a task due today late", () => {
    // Comparing a date-only value to the clock marks anything due today as
    // overdue from one minute past midnight.
    expect(isOverdue("2026-09-05T00:00:00Z", false, now)).toBe(false);
  });

  it("calls yesterday late", () => {
    expect(isOverdue("2026-09-04T00:00:00Z", false, now)).toBe(true);
  });

  it("compares an instant against the clock, not the day", () => {
    expect(isOverdue("2026-09-05T09:00:00Z", true, now)).toBe(true);
    expect(isOverdue("2026-09-05T18:00:00Z", true, now)).toBe(false);
  });

  it("is never overdue with no date", () => {
    expect(isOverdue(null, false, now)).toBe(false);
    expect(isOverdue(undefined, true, now)).toBe(false);
  });
});

describe("the month grid", () => {
  it("is always six weeks, so paging does not change the page height", () => {
    for (const month of ["2026-02", "2026-09", "2026-11", "2027-01"]) {
      const grid = monthGrid(month);
      expect(grid).toHaveLength(6);
      expect(grid.every((week) => week.length === 7)).toBe(true);
    }
  });

  it("starts on the Monday on or before the first of the month", () => {
    // 1 September 2026 is a Tuesday, so the grid opens on 31 August.
    expect(monthGrid("2026-09")[0]?.[0]).toBe("2026-08-31");
    expect(monthGrid("2026-09")[0]?.[1]).toBe("2026-09-01");
  });

  it("runs continuously with no gaps or repeats", () => {
    const days = monthGrid("2026-09").flat();
    expect(new Set(days).size).toBe(42);
    days.forEach((day, index) => {
      if (index === 0) return;
      expect(day).toBe(utcDayKey(addUtcDays(days[index - 1]!, 1)));
    });
  });

  it("covers a February that starts on a Monday without dropping a week", () => {
    // 1 February 2027 is a Monday: 28 days from a Monday is exactly four weeks,
    // and the two padding weeks are what keep the grid a fixed height.
    const grid = monthGrid("2027-02");
    expect(grid[0]?.[0]).toBe("2027-02-01");
    expect(grid[5]?.[6]).toBe("2027-03-14");
  });

  it("gives a range covering exactly what it draws", () => {
    const { from, to } = monthRange("2026-09");
    const grid = monthGrid("2026-09");
    expect(from).toBe(`${grid[0]?.[0]}T00:00:00.000Z`);
    // Half-open: the day after the last square, so a task at midnight on the
    // final day is inside and one a moment into the next day is not.
    expect(to).toBe("2026-10-12T00:00:00.000Z");
  });
});

describe("month arithmetic", () => {
  it("steps across a year boundary in both directions", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-09", 0)).toBe("2026-09");
  });

  it("names the month a day belongs to", () => {
    expect(monthOf("2026-09-04")).toBe("2026-09");
  });

  it("recognizes a month, and refuses anything else", () => {
    expect(isMonth("2026-09")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("2026-9")).toBe(false);
    expect(isMonth("2026-09-04")).toBe(false);
    expect(isMonth(undefined)).toBe(false);
  });

  it("refuses a value that is not a date rather than inventing one", () => {
    expect(() => utcDayKey("not a date")).toThrow(RangeError);
    expect(() => monthGrid("2026-99")).toThrow(RangeError);
  });
});

describe("a month's own days", () => {
  it("holds exactly the days of that month, and none of its neighbours'", () => {
    expect(daysOfMonth("2026-09")).toHaveLength(30);
    expect(daysOfMonth("2026-09")[0]).toBe("2026-09-01");
    expect(daysOfMonth("2026-09")[29]).toBe("2026-09-30");
  });

  it("handles February, leap and otherwise", () => {
    expect(daysOfMonth("2026-02")).toHaveLength(28);
    expect(daysOfMonth("2028-02")).toHaveLength(29);
  });

  it("bounds the month half-open, so midnight on the last day is inside", () => {
    const { from, to } = monthBounds("2026-09");
    expect(from).toBe("2026-09-01T00:00:00.000Z");
    expect(to).toBe("2026-10-01T00:00:00.000Z");
  });

  it("is narrower than the calendar's padded grid", () => {
    // The grid pads to six weeks so squares line up; a timeline's columns must
    // not include days from another month.
    expect(daysOfMonth("2026-09").length).toBeLessThan(monthGrid("2026-09").flat().length);
  });
});

describe("an instant has no implied zone", () => {
  // The other half of this module's rule, and the one that shipped a bug. The
  // three screens that print "5m ago" also render on the server, so each
  // instant was formatted twice — once in the server's zone, once in the
  // viewer's — and React threw the tree away when the two disagreed (D-121).
  //
  // The disagreement needs no React to reproduce. Flipping the ambient zone is
  // exactly what moving from the server to the browser does.
  const stored = "2026-10-10T03:12:11.034Z";

  const inZone = <T,>(timeZone: string, read: () => T): T => {
    const before = process.env.TZ;
    process.env.TZ = timeZone;
    try {
      return read();
    } finally {
      process.env.TZ = before;
    }
  };

  it("reads the zone it is running in when none is named — the server's, on a server", () => {
    expect(inZone("America/Los_Angeles", () => instantDay(stored))).toBe("9 Oct");
    expect(inZone("Asia/Tokyo", () => instantDay(stored))).toBe("10 Oct");
  });

  it("gives one answer everywhere once a zone is named, which is what hydration needs", () => {
    expect(inZone("America/Los_Angeles", () => instantDay(stored, "UTC"))).toBe("10 Oct");
    expect(inZone("Asia/Tokyo", () => instantDay(stored, "UTC"))).toBe("10 Oct");
  });

  it("says which zone it pinned, so a pinned time is not read as a local one", () => {
    expect(inZone("America/Los_Angeles", () => instantStamp(stored, "UTC"))).toBe(
      "10 Oct 2026, 03:12 UTC",
    );
    expect(inZone("Asia/Tokyo", () => instantStamp(stored, "UTC"))).toBe(
      "10 Oct 2026, 03:12 UTC",
    );
  });

  it("and leaves the name off when the zone is the reader's own", () => {
    expect(inZone("Asia/Tokyo", () => instantStamp(stored))).toBe("10 Oct 2026, 12:12");
    expect(inZone("America/Los_Angeles", () => instantStamp(stored))).toBe("9 Oct 2026, 20:12");
  });

  it("throws on a value that is not a date rather than printing one", () => {
    expect(() => instantStamp("not a date")).toThrow(RangeError);
    expect(() => instantDay("not a date")).toThrow(RangeError);
  });
});

describe("a due date in the four view renderers", () => {
  // The same bug as above, found four more times (D-132). These are the
  // regression tests for it: `dueLabel` is the only thing those renderers call
  // now, and the zone is an argument rather than an ambient fact.
  const inZone = <T,>(timeZone: string, read: () => T): T => {
    const before = process.env.TZ;
    process.env.TZ = timeZone;
    try {
      return read();
    } finally {
      process.env.TZ = before;
    }
  };

  /** 03:34 UTC is the previous evening in Los Angeles and the same day in Tokyo. */
  const instant = "2026-10-22T03:34:30.206Z";
  /** Midnight UTC: the calendar day the seed stores (D-067). */
  const day = "2026-10-22T00:00:00.000Z";

  it("reads a calendar day in UTC whatever zone is asked for, because it has one answer", () => {
    for (const timeZone of ["UTC", "America/Los_Angeles", "Asia/Tokyo", undefined]) {
      expect(dueLabel(day, false, "weekday", timeZone)).toBe("Thu 22");
      expect(dueLabel(day, false, "month", timeZone)).toBe("22 Oct");
    }
  });

  it("reads a calendar day the same way wherever it is running", () => {
    expect(inZone("America/Los_Angeles", () => dueLabel(day, false, "weekday"))).toBe("Thu 22");
    expect(inZone("Asia/Tokyo", () => dueLabel(day, false, "weekday"))).toBe("Thu 22");
  });

  it("pins an instant when a zone is named, which is what hydration compares", () => {
    expect(inZone("America/Los_Angeles", () => dueLabel(instant, true, "weekday", "UTC"))).toBe(
      "Thu 22",
    );
    expect(inZone("Asia/Tokyo", () => dueLabel(instant, true, "weekday", "UTC"))).toBe("Thu 22");
  });

  it("and reads the zone it is running in when none is named — the bug, kept as a test", () => {
    // This is the divergence itself: one stored instant, two days. It is only
    // correct in a browser, which is why `DueDate` names UTC until it has
    // hydrated.
    expect(inZone("UTC", () => dueLabel(instant, true, "weekday"))).toBe("Thu 22");
    expect(inZone("America/Los_Angeles", () => dueLabel(instant, true, "weekday"))).toBe("Wed 21");
  });

  it("formats both shapes the four renderers use", () => {
    expect(dueLabel(instant, true, "weekday", "UTC")).toBe("Thu 22");
    expect(dueLabel(instant, true, "month", "UTC")).toBe("22 Oct");
  });

  it("throws on a value that is not a date, like its siblings", () => {
    expect(() => dueLabel("not a date", true, "weekday", "UTC")).toThrow(RangeError);
  });
});
