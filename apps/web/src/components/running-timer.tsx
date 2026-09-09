"use client";

import { formatClock } from "@arbor/core";
import { useEffect, useState } from "react";

import { stopTimer } from "@/server/time-actions";

import { type RunningTimer, useRunningTimer } from "./live";
import { useTaskAction } from "./use-task-action";

/**
 * The running timer, in the chrome of every screen.
 *
 * **It belongs to the shell for the same reason the inbox badge does** (D-085):
 * it is a fact about the person rather than about the screen, and threading it
 * through every page would be seven call sites that each have to remember. A
 * timer you started an hour ago and can only see by navigating back to the task
 * is a timer you will forget is running.
 *
 * **Two sources, and which one wins is the whole design.** The server render is
 * the seed — correct at the moment the page was assembled. The stream is the
 * truth after that, because a nudge about your own writes never causes a
 * refresh: `Live` filters your own changes out, which is right for everything
 * except the one piece of state that is *yours* and global. So `undefined` from
 * the context means "the stream has not spoken", and anything else replaces the
 * seed (D-098).
 */
export function RunningTimerReadout({
  initial,
  loadedAt,
}: {
  initial: RunningTimer | null;
  /** When the server rendered, so the first frame is not a hydration mismatch. */
  loadedAt: string;
}) {
  const pushed = useRunningTimer();
  const running = pushed === undefined ? initial : pushed;

  const [elapsed, setElapsed] = useState(() =>
    running ? Math.max(0, new Date(loadedAt).getTime() - new Date(running.startedAt).getTime()) : 0,
  );
  const { run, pending } = useTaskAction();

  const startedAt = running?.startedAt ?? null;

  useEffect(() => {
    if (!startedAt) return;

    const start = new Date(startedAt).getTime();
    const tick = () => setElapsed(Math.max(0, Date.now() - start));

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  // Nothing running is nothing shown. A dormant timer control sitting in the
  // header of every screen is a permanent invitation to a feature most people
  // use on some days and not others.
  if (!running) return null;

  return (
    <div className="running-timer" data-pending={pending || undefined}>
      {/* The task is a link, not a label: the readout's second job is getting
          you back to what you were doing. It says "a task" when the viewer can
          no longer reach it — the entry is theirs, the task's name is not
          (D-095). */}
      {running.taskKey || running.taskName ? (
        <a className="running-timer-task" href={`/t/${running.taskKey ?? running.taskId}`}>
          {running.taskKey ?? running.taskName}
        </a>
      ) : (
        <span className="running-timer-task" title="You no longer have access to this task">
          a task
        </span>
      )}

      <span className="running-timer-clock">{formatClock(elapsed)}</span>

      <button
        type="button"
        className="running-timer-stop"
        aria-label="Stop the running timer"
        title="Stop the timer"
        onClick={() => run(() => stopTimer())}
      >
        ■
      </button>
    </div>
  );
}
