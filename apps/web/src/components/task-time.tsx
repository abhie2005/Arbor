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

import { relative } from "./relative-time";

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
  const [minutes, setMinutes] = useState(estimateMs === null ? "" : String(estimateMs / 60_000));

  // The server's value wins whenever it changes underneath — a live update, or
  // somebody else's edit. Following `useServerValue`'s rule (D-090) rather than
  // taking the prop once and never looking again.
  const [seen, setSeen] = useState(estimateMs);
  if (seen !== estimateMs) {
    setSeen(estimateMs);
    setMinutes(estimateMs === null ? "" : String(estimateMs / 60_000));
  }

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
          <>
            <input
              type="number"
              min="0"
              step="15"
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              onBlur={() => {
                const next = minutes.trim() === "" ? null : Number(minutes);
                const current = estimateMs === null ? null : estimateMs / 60_000;
                if (next === current) return;
                act(() => setTimeEstimate(taskId, next));
              }}
            />
            <span className="time-unit">min</span>
          </>
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
 * Minutes, because that is what a person knows about work they have already
 * done. The action turns it into two instants by counting backwards from now —
 * a claim about a duration has to become a row with a start and an end, and
 * inventing the start is the honest half of that.
 */
function LogForm({
  taskId,
  act,
}: {
  taskId: string;
  act: (action: () => Promise<Operation[]>) => void;
}) {
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  const [billable, setBillable] = useState(false);

  const submit = () => {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value <= 0) return;

    act(() => logTime(taskId, value, note, billable));
    setMinutes("");
    setNote("");
    setBillable(false);
  };

  return (
    <div className="time-log">
      <input
        type="number"
        min="1"
        step="5"
        placeholder="30"
        aria-label="Minutes to log"
        value={minutes}
        onChange={(event) => setMinutes(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      />
      <span className="time-unit">min</span>

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

      <button type="button" onClick={submit} disabled={minutes.trim() === ""}>
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

      <time className="time-when" dateTime={entry.startedAt}>
        {runningNow ? "running" : relative(entry.endedAt ?? entry.startedAt)}
      </time>

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
  const [minutes, setMinutes] = useState(String(Math.round((entry.durationMs ?? 0) / 60_000)));
  const [note, setNote] = useState(entry.description ?? "");
  const [billable, setBillable] = useState(entry.isBillable);

  return (
    <div className="time-editor">
      <input
        type="number"
        min="1"
        step="5"
        aria-label="How long it was, in minutes"
        value={minutes}
        onChange={(event) => setMinutes(event.target.value)}
      />
      <span className="time-unit">min</span>

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
          const value = Number(minutes);
          act(() => updateTimeEntry(entry.id, Number.isFinite(value) ? value : null, note, billable));
          done();
        }}
      >
        Save
      </button>
    </div>
  );
}
