/**
 * Tracked time, as values.
 *
 * `time_entries` has existed since migration 0000 and nothing has ever written
 * to it. The column comments carry decisions that were made when the schema was
 * designed, and this module is where they become rules rather than prose:
 *
 * - **A running entry is one with `endedAt` null.** There is no `is_running`
 *   flag to disagree with the timestamps, so "running" is a question the row
 *   answers on its own — the same shape as `archivedAt` and `deletedAt`
 *   everywhere else.
 * - **`durationMs` is denormalized on stop**, so a timesheet sums a column
 *   instead of subtracting timestamps across a million rows. It is therefore
 *   *derived*, and deliberately not part of what an operation carries: a client
 *   that could send a duration could send one that disagreed with its own
 *   timestamps, and the disagreement would be invisible until a report was
 *   wrong. The executor computes it in SQL from the two stored instants.
 *
 * Pure, like the rest of `@arbor/core`: no database, no clock of its own. The
 * caller supplies `now`, which is what lets a test say "and then it was
 * Tuesday" without waiting.
 */

/** What an entry says about itself. Everything else about it is derived. */
export interface TimeEntryValues {
  startedAt: Date;
  /** Null while it is running. The whole state machine is this one field. */
  endedAt: Date | null;
  description: string | null;
  isBillable: boolean;
}

export class TimeEntryInvalid extends Error {}

/**
 * Clock tolerance when deciding whether a start is "in the future".
 *
 * Not paranoia: Postgres runs in a VM on this machine and its clock drifts tens
 * of milliseconds either way from the app's, which is enough to make a timer
 * started this instant look like it starts later. A minute swallows that with
 * room to spare and still refuses next Tuesday.
 */
const FUTURE_TOLERANCE_MS = 60_000;

export function isRunning(values: TimeEntryValues): boolean {
  return values.endedAt === null;
}

/**
 * How long an entry is, in milliseconds.
 *
 * A running entry is measured against `now`, so a timer that has been going for
 * ten minutes reports ten minutes without anything having been written. That is
 * the reason this takes a clock rather than reading one: the server renders the
 * number once and the browser keeps counting from the same start instant, and
 * the two agree because they are the same function over different `now`s.
 */
export function entryDurationMs(values: TimeEntryValues, now: Date = new Date()): number {
  const end = values.endedAt ?? now;
  return Math.max(0, end.getTime() - values.startedAt.getTime());
}

/**
 * Refuses an entry that cannot be true.
 *
 * Three rules, and each one exists because the alternative is a row that no
 * report can interpret: an entry that ends before it starts would contribute a
 * negative duration to a sum; an entry that starts in the future would make
 * "time tracked this week" depend on when you asked; and an invalid date is a
 * `NaN` duration, which propagates through a `SUM` and takes the whole
 * timesheet with it.
 *
 * There is deliberately **no maximum length**. A timer left running over a
 * weekend is a real thing that happens, and the honest answer is a long entry
 * the person can edit — not a refusal, and not a cap that silently truncates
 * work somebody actually did.
 */
export function validateTimeEntry(values: TimeEntryValues, now: Date = new Date()): void {
  if (Number.isNaN(values.startedAt.getTime())) {
    throw new TimeEntryInvalid("That start time is not a date");
  }

  if (values.startedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    throw new TimeEntryInvalid("Time cannot be tracked in the future");
  }

  if (values.endedAt === null) return;

  if (Number.isNaN(values.endedAt.getTime())) {
    throw new TimeEntryInvalid("That end time is not a date");
  }

  if (values.endedAt.getTime() <= values.startedAt.getTime()) {
    throw new TimeEntryInvalid("A time entry has to end after it starts");
  }
}

/** Two entries hold the same values — what tells an edit from an accident. */
export function sameTimeEntry(a: TimeEntryValues, b: TimeEntryValues): boolean {
  return (
    a.startedAt.getTime() === b.startedAt.getTime() &&
    (a.endedAt?.getTime() ?? null) === (b.endedAt?.getTime() ?? null) &&
    (a.description ?? "") === (b.description ?? "") &&
    a.isBillable === b.isBillable
  );
}

/**
 * "2h 30m", "45m", "0m".
 *
 * One vocabulary for every duration on every screen. The table used to carry
 * its own — `2.5h` — which was fine until the detail page put tracked time next
 * to an estimate and the same quantity was written two ways on two screens. A
 * second copy of a formatter is where a helper stops being local, and this
 * codebase has already learned that lesson once, at six copies of a sidebar.
 *
 * Minutes, never seconds. A timesheet reporting `2h 30m 07s` is claiming a
 * precision that a person clicking a button does not have — `formatClock` is
 * for the one place seconds are honest, which is a timer while it runs.
 */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/**
 * "1:23:45" — a running timer, ticking.
 *
 * Seconds are shown here and nowhere else, because here they are the point: a
 * readout that does not move is indistinguishable from one that has stopped,
 * and "is my timer actually running" is the only question this control answers.
 */
export function formatClock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Tracked against estimated, as a percentage — or null when there is nothing to
 * compare against.
 *
 * Null rather than zero or a hundred: a task with no estimate has not had 0% of
 * its time used, it has no answer, and a progress bar sitting at zero is a
 * claim. The caller renders the tracked total on its own in that case.
 *
 * **Not clamped.** Going over an estimate is the single most useful thing this
 * number can tell anyone, and a bar that stops at 100% hides exactly the tasks
 * worth looking at. The renderer decides what over-full looks like.
 */
export function trackedPercent(trackedMs: number, estimateMs: number | null): number | null {
  if (estimateMs === null || estimateMs <= 0) return null;
  return (trackedMs / estimateMs) * 100;
}
