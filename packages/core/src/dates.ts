/**
 * Calendar days and instants.
 *
 * A task's due date is one of two different things, and the schema already
 * says which: `due_has_time = false` means a calendar day — "the 4th" — and
 * true means a moment. The distinction exists because a date-only value
 * formatted in a viewer's local zone lands on the wrong day for anyone whose
 * offset crosses the stored time, which is the note written on the column
 * itself.
 *
 * Nothing read the flag until the calendar. Three renderers formatted every
 * date with `toLocaleDateString` and no zone, so a task stored as the 4th
 * displayed as the 3rd on this machine — invisible while the only question was
 * what a row says, and immediately visible once a task has to sit in a square.
 *
 * **The rule.** A calendar day is stored at UTC midnight and read back in UTC.
 * An instant is stored and read in the viewer's zone. Both are the same column;
 * the flag decides which frame to use, and it is the only thing that may.
 */

/** `YYYY-MM-DD` for the day a value falls on, in UTC. */
export function utcDayKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Not a date: ${String(value)}`);
  return date.toISOString().slice(0, 10);
}

/** Midnight UTC on the day a value falls on. */
export function startOfUtcDay(value: string | Date): Date {
  return new Date(`${utcDayKey(value)}T00:00:00.000Z`);
}

export function addUtcDays(value: string | Date, days: number): Date {
  const date = startOfUtcDay(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

/**
 * How a stored value should be read.
 *
 * A calendar day is read in UTC so it is the same day everywhere. An instant is
 * read wherever the reader is, because that is what an instant means.
 */
export function dateFrame(hasTime: boolean): { timeZone?: string } {
  return hasTime ? {} : { timeZone: "UTC" };
}

/**
 * The day a value belongs to, for grouping into squares.
 *
 * A calendar day answers in UTC. An instant answers in the zone it is being
 * read in, which the caller supplies — the server has no business guessing a
 * viewer's zone, and passing none means UTC rather than the server's own.
 */
export function dayKeyFor(
  value: string | Date,
  hasTime: boolean,
  timeZone = "UTC",
): string {
  if (!hasTime) return utcDayKey(value);

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Not a date: ${String(value)}`);

  // `en-CA` formats as YYYY-MM-DD, which is the key shape, and Intl is the
  // only thing in the language that can shift a date into a named zone.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Whether a due date has passed.
 *
 * A calendar day is not overdue until the day is over — comparing a date-only
 * value to `Date.now()` marks anything due today as late from one minute past
 * midnight, which is the sort of wrong that makes people stop trusting the
 * colour.
 */
export function isOverdue(
  value: string | Date | null | undefined,
  hasTime: boolean,
  now: Date = new Date(),
): boolean {
  if (!value) return false;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;

  return hasTime ? date.getTime() < now.getTime() : utcDayKey(date) < utcDayKey(now);
}

/**
 * The weeks of a month as day keys, Monday-first, padded with the neighbouring
 * days that share a week.
 *
 * Always six rows. A month grid that is five rows in November and six in
 * December changes height as you page through it, and every row below it moves.
 */
export function monthGrid(month: string): string[][] {
  const first = startOfUtcDay(`${month}-01`);
  if (Number.isNaN(first.getTime())) throw new RangeError(`Not a month: ${month}`);

  // getUTCDay is Sunday-0; shift so Monday is the first column.
  const lead = (first.getUTCDay() + 6) % 7;
  const start = addUtcDays(first, -lead);

  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => utcDayKey(addUtcDays(start, week * 7 + day))),
  );
}

/** `YYYY-MM` for the month a day key belongs to. */
export function monthOf(dayKey: string): string {
  return dayKey.slice(0, 7);
}

export function addMonths(month: string, delta: number): string {
  const [year, index] = month.split("-").map(Number);
  if (!year || !index) throw new RangeError(`Not a month: ${month}`);

  const date = new Date(Date.UTC(year, index - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The half-open range a month grid covers, for filtering the query to it. */
export function monthRange(month: string): { from: string; to: string } {
  const weeks = monthGrid(month);
  const first = weeks[0]?.[0];
  const last = weeks[5]?.[6];
  if (!first || !last) throw new RangeError(`Not a month: ${month}`);

  return { from: `${first}T00:00:00.000Z`, to: `${utcDayKey(addUtcDays(last, 1))}T00:00:00.000Z` };
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH_RE.test(value);
}

/**
 * The days of a month, without the neighbouring ones a grid pads with.
 *
 * A calendar shows six weeks because its squares have to line up under weekday
 * headings. A timeline's columns are days, and padding them with last month's
 * would put bars in a month they do not belong to.
 */
export function daysOfMonth(month: string): string[] {
  const first = startOfUtcDay(`${month}-01`);
  if (Number.isNaN(first.getTime())) throw new RangeError(`Not a month: ${month}`);

  const days: string[] = [];
  for (let day = first; utcDayKey(day).startsWith(month); day = addUtcDays(day, 1)) {
    days.push(utcDayKey(day));
  }
  return days;
}

/** The half-open range covering exactly that month. */
export function monthBounds(month: string): { from: string; to: string } {
  const days = daysOfMonth(month);
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) throw new RangeError(`Not a month: ${month}`);

  return { from: `${first}T00:00:00.000Z`, to: `${utcDayKey(addUtcDays(last, 1))}T00:00:00.000Z` };
}
