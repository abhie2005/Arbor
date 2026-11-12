"use client";

import {
  type Operation,
  formatClock,
  formatDuration,
  trackedPercent,
} from "@arbor/core";
import type { TimeEntryRecord } from "@arbor/db";
import { useEffect, useState } from "react";

import {
  deleteTimeEntry,
  logTime,
  setTimeEstimate,
  startTimer,
  stopTimer,
  updateTimeEntry,
} from "@/server/time-actions";

import { DurationInput } from "./duration-input";
import { Timestamp } from "./timestamp";

/**
 * Tracked time on a task.
 *
 * Everything that writes goes through the `act` the detail page already has, so
 * the four rules a writing control needs — transition, inverse on the undo
 * stack, failure shown, revert on refusal — arrive without being restated
 * (D-064). ⌘Z undoes a stop, which is the visible half of time entries being
 * operations (D-093).
 *
 * **The running entry is the only thing on this page that moves by itself.**
 * Everything else here is a server value that changes when the page
 * re-renders; a timer has to tick, because a readout that does not move is
 * indistinguishable from one that has stopped.
 */

export interface TaskTimeProps {
  taskId: string;
  entries: TimeEntryRecord[];
  estimateMs: number | null;
  canEdit: boolean;
  viewerId: string;
  /**
   * When the server assembled this page.
   *
   * It exists so the first paint is deterministic. The ticking clock needs a
   * `now`, the server and the browser do not have the same one, and React
   * renders this component on both — reading `Date.now()` during render is a
   * hydration mismatch that appears as a flicker and warns in the console. So
   * the first frame is measured against an instant that arrived as a prop, and
   * the real clock takes over once mounted.
   */
  loadedAt: string;
  act: (action: () => Promise<Operation[]>, revert?: () => void) => void;
}

export function TaskTime({
  taskId,
  entries,
  estimateMs,
  canEdit,
  viewerId,
  loadedAt,
  act,
}: TaskTimeProps) {
  const running = entries.find((entry) => entry.endedAt === null) ?? null;
  const yoursIsRunning = running?.userId === viewerId;

  const elapsed = useElapsed(running?.startedAt ?? null, loadedAt);

  // Stopped entries sum from the denormalized column — which is what it is for.
  // The running one is measured against the same clock the readout uses, or the
  // total would disagree with the timer ticking three lines above it.
  const stoppedMs = entries.reduce((total, entry) => total + (entry.durationMs ?? 0), 0);
  const trackedMs = stoppedMs + elapsed;
  const percent = trackedPercent(trackedMs, estimateMs);

  return (
    <section className="detail-section time">
      <h2>
        Time
        {trackedMs > 0 ? <span className="time-total">{formatDuration(trackedMs)}</span> : null}

        {canEdit || yoursIsRunning ? (
          <button
            type="button"
            className="time-toggle"
            data-running={yoursIsRunning || undefined}
            onClick={() => act(() => (yoursIsRunning ? stopTimer() : startTimer(taskId)))}
          >
            {yoursIsRunning ? `Stop · ${formatClock(elapsed)}` : "Start timer"}
          </button>
        ) : null}
      </h2>

      {/* Somebody else's timer is running on this task. Worth saying — two
          people tracking the same task at the same time is usually a mistake,
          and it is invisible if the only signal is a total that grows. */}
      {running && !yoursIsRunning ? (
        <p className="time-elsewhere">
          {running.userName ?? "Somebody"} has a timer running on this task.
        </p>
      ) : null}

      <Estimate
        taskId={taskId}
        estimateMs={estimateMs}
        trackedMs={trackedMs}
        percent={percent}
        canEdit={canEdit}
        act={act}
      />

      {canEdit ? <LogForm taskId={taskId} act={act} /> : null}

      {entries.length > 0 ? (
        <ul className="time-list">
          {entries.map((entry) => (
            <Entry
              key={entry.id}
              entry={entry}
              elapsed={entry.endedAt === null ? elapsed : null}
              mine={entry.userId === viewerId}
              act={act}
            />
          ))}
        </ul>
      ) : (
        <p className="time-empty">No time tracked on this task yet.</p>
      )}
    </section>
  );
}

/**
 * Milliseconds since a running entry started, ticking.
 *
 * Zero when nothing is running, so callers can add it to a total unconditionally
 * rather than branching around it.
 *
 * The interval is one second and it is not adjusted for drift. A clock that is
 * a few milliseconds late is a clock nobody can see being late; the thing that
 * would be visible is a second that occasionally does not advance, which is
 * what a naive drift correction produces.
 */
function useElapsed(startedAt: string | null, loadedAt: string): number {
  const seed = startedAt ? new Date(loadedAt).getTime() - new Date(startedAt).getTime() : 0;
  const [elapsed, setElapsed] = useState(Math.max(0, seed));

  useEffect(() => {
    if (!startedAt) {
      setElapsed(0);
      return;
    }

    const start = new Date(startedAt).getTime();
    const tick = () => setElapsed(Math.max(0, Date.now() - start));

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return elapsed;
}

/**
 * Tracked against estimated.
 *
 * The estimate is `tasks.time_estimate_ms` — the task-level one (D-096). The
 * bar is not clamped: going over is the most useful thing this number says, and
 * a bar that stops at 100% hides exactly the tasks worth looking at.
 */
function Estimate({
  taskId,
  estimateMs,
  trackedMs,
  percent,
  canEdit,
  act,
}: {
  taskId: string;
  estimateMs: number | null;
  trackedMs: number;
  percent: number | null;
  canEdit: boolean;
  act: (action: () => Promise<Operation[]>) => void;
}) {
  return (
    <div className="time-estimate">
      <div className="time-bar">
        <span className="time-bar-track">
          <span
            className="time-bar-fill"
            data-over={percent !== null && percent > 100 ? "true" : undefined}
            style={{ width: `${Math.min(100, percent ?? 0)}%` }}
          />
        </span>
        <span className="time-bar-label">
          {estimateMs === null
            ? formatDuration(trackedMs)
            : `${formatDuration(trackedMs)} of ${formatDuration(estimateMs)}`}
          {percent === null ? null : ` · ${Math.round(percent)}%`}
        </span>
      </div>

      <label className="time-estimate-field">
        Estimate
        {canEdit ? (
          // The same box the filter bar and an automation action use (D-148),
          // which is the point: an estimate was written in minutes here and
          // read as "2h 30m" everywhere else, including two lines above. It
          // publishes on blur rather than on every keystroke because this
          // receiver is a server write, and the hook that owns the state is
          // inside the control — which is also how it keeps following the
          // server (D-090), the thing this component used to hand-roll.
          <DurationInput
            value={estimateMs}
            commitOn="blur"
            ariaLabel="Estimate"
            className="time-duration"
            placeholder="2h 30m"
            onChange={(ms) =>
              // The action's unit is minutes and stays minutes: it is a
              // boundary with a check written against it, and the column it
              // writes is milliseconds either way.
              act(() => setTimeEstimate(taskId, ms === null ? null : Math.round(ms / 60_000)))
            }
          />
        ) : (
          <span>{estimateMs === null ? "None" : formatDuration(estimateMs)}</span>
        )}
      </label>
    </div>
  );
}

/**
 * Logging time that was spent without a timer running.
 *
 * A duration, because that is what a person knows about work they have already
 * done — "half an hour", not a start and an end. The action turns it into two
 * instants by counting backwards from now: a claim about a duration has to
 * become a row with a start and an end, and inventing the start is the honest
 * half of that.
 *
 * The box takes "30m" or "1h 30m" or a bare number of minutes (D-148), and its
 * draft is this component's state because the value is not wanted until Enter
 * or the button.
 */
function LogForm({
  taskId,
  act,
}: {
  taskId: string;
  act: (action: () => Promise<Operation[]>) => void;
}) {
  const [ms, setMs] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [billable, setBillable] = useState(false);

  const submit = () => {
    if (ms === null || ms <= 0) return;

    act(() => logTime(taskId, Math.round(ms / 60_000), note, billable));
    setMs(null);
    setNote("");
    setBillable(false);
  };

  return (
    <div className="time-log">
      <DurationInput
        value={ms}
        onChange={setMs}
        ariaLabel="How long to log"
        className="time-duration"
        placeholder="30m"
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          // Blur first: the box holds its own draft while it has focus, so
          // clearing the value behind a focused box would leave the text
          // sitting there after the time was logged.
          event.currentTarget.blur();
          submit();
        }}
      />

      <input
        type="text"
        placeholder="What was it?"
        aria-label="What the time was spent on"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      />

      {/* The column exists and nothing else in the product mentions billing
          (it is a column waiting for a decision, not a feature). Offered here
          because an entry that was billable and cannot say so is a fact lost at
          the moment it was known. */}
      <label className="time-billable">
        <input
          type="checkbox"
          checked={billable}
          onChange={(event) => setBillable(event.target.checked)}
        />
        Billable
      </label>

      <button type="button" onClick={submit} disabled={ms === null || ms <= 0}>
        Log
      </button>
    </div>
  );
}

/**
 * One entry.
 *
 * **Only your own is editable**, the same rule as a comment: someone with
 * `edit` on the list may change everything else about this task, and they may
 * not rewrite how long somebody else says they worked.
 */
function Entry({
  entry,
  elapsed,
  mine,
  act,
}: {
  entry: TimeEntryRecord;
  /** Set only for the running entry, so its length comes from the clock. */
  elapsed: number | null;
  mine: boolean;
  act: (action: () => Promise<Operation[]>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const runningNow = entry.endedAt === null;

  return (
    <li className="time-entry" data-running={runningNow || undefined}>
      <span className="time-who">{entry.userName ?? "Someone"}</span>

      <span className="time-length">
        {runningNow ? formatClock(elapsed ?? 0) : formatDuration(entry.durationMs ?? 0)}
      </span>

      {entry.description ? <span className="time-note">{entry.description}</span> : null}
      {entry.isBillable ? <span className="time-flag">billable</span> : null}

      {runningNow ? (
        <time className="time-when" dateTime={entry.startedAt}>
          running
        </time>
      ) : (
        <Timestamp className="time-when" at={entry.endedAt ?? entry.startedAt} />
      )}

      {mine && !runningNow ? (
        <span className="time-actions">
          <button type="button" onClick={() => setEditing((open) => !open)}>
            {editing ? "Cancel" : "Edit"}
          </button>
          <button
            type="button"
            className="time-delete"
            aria-label="Delete this entry"
            onClick={() => act(() => deleteTimeEntry(entry.id))}
          >
            ×
          </button>
        </span>
      ) : null}

      {editing ? (
        <EntryEditor
          entry={entry}
          act={act}
          done={() => setEditing(false)}
        />
      ) : null}
    </li>
  );
}

function EntryEditor({
  entry,
  act,
  done,
}: {
  entry: TimeEntryRecord;
  act: (action: () => Promise<Operation[]>) => void;
  done: () => void;
}) {
  const [ms, setMs] = useState<number | null>(entry.durationMs ?? null);
  const [note, setNote] = useState(entry.description ?? "");
  const [billable, setBillable] = useState(entry.isBillable);

  return (
    <div className="time-editor">
      <DurationInput value={ms} onChange={setMs} ariaLabel="How long it was" className="time-duration" />

      <input
        type="text"
        aria-label="What the time was spent on"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />

      <label className="time-billable">
        <input
          type="checkbox"
          checked={billable}
          onChange={(event) => setBillable(event.target.checked)}
        />
        Billable
      </label>

      <button
        type="button"
        onClick={() => {
          // The action's unit is minutes, and stays minutes: it is a boundary
          // with a check written against it (D-148).
          act(() =>
            updateTimeEntry(entry.id, ms === null ? null : Math.round(ms / 60_000), note, billable),
          );
          done();
        }}
      >
        Save
      </button>
    </div>
  );
}
