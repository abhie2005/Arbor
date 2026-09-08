"use client";

import { type Operation, dateFrame, isOverdue } from "@arbor/core";
import { useState } from "react";

import { archiveTask, cycleStatus, renameTask, setPriority } from "@/server/actions";

import { useServerValue } from "./use-server-value";
import { useTaskAction } from "./use-task-action";

export interface TaskRowData {
  id: string;
  key: string | null;
  name: string;
  priority: number | null;
  statusGroup: string | null;
  dueAt: string | null;
  /** False means a calendar day; it decides the zone the date is read in. */
  dueHasTime: boolean;
  assignees: string[];
  subtaskCount: number;
}

const PRIORITY_CYCLE = [null, 1, 2, 3, 4] as const;

export function TaskRow({ task }: { task: TaskRowData }) {
  const [editing, setEditing] = useState(false);
  // Optimistic name: the row shows the new value on keystroke and reconciles
  // when the server responds, rather than waiting for a round trip. The server
  // is authoritative — for a refused rename, and for one that arrives from
  // somebody else while this row is on screen (D-090). Held while editing, so a
  // live update does not overwrite what is being typed.
  const [name, setName] = useServerValue(task.name, editing);
  const { run, pending, failure } = useTaskAction();
  const act = (action: () => Promise<Operation[]>) => run(action, () => setName(task.name));

  const due = formatDue(task.dueAt, task.dueHasTime);

  return (
    <div className="row" data-pending={pending || undefined} data-failed={failure ? true : undefined}>
      <button
        type="button"
        className="dot-button"
        title="Advance status"
        aria-label={`Advance status of ${task.name}`}
        onClick={() => act(() => cycleStatus(task.id))}
      >
        <span className="dot" data-group={task.statusGroup ?? undefined} />
      </button>

      {/* The key is the permalink (D-082). Clicking the *name* already means
          rename on this renderer, so the identifier that exists to be cited is
          what opens the task. */}
      <a className="key task-link" href={`/t/${task.key ?? task.id}`} title="Open task">
        {task.key ?? "—"}
      </a>

      {editing ? (
        <input
          className="title-input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (name.trim() && name !== task.name) act(() => renameTask(task.id, name));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setName(task.name);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button type="button" className="title" onClick={() => setEditing(true)}>
          {name}
          {task.subtaskCount > 0 ? <span className="sub">{task.subtaskCount} subtasks</span> : null}
        </button>
      )}

      <button
        type="button"
        className="flag"
        data-priority={task.priority ?? undefined}
        title="Change priority"
        aria-label={`Change priority of ${task.name}`}
        onClick={() => {
          const index = PRIORITY_CYCLE.indexOf(task.priority as never);
          const next = PRIORITY_CYCLE[(index + 1) % PRIORITY_CYCLE.length] ?? null;
          run(() => setPriority(task.id, next));
        }}
      >
        {task.priority ? "▲" : "△"}
      </button>

      <span className="date" data-overdue={due.overdue} data-empty={due.empty}>
        {due.label}
      </span>

      <span className="avatars">
        {task.assignees.map((person) => (
          <span
            key={person}
            className="avatar"
            style={{ background: avatarColor(person) }}
            title={person}
          >
            {initials(person)}
          </span>
        ))}
      </span>

      <button
        type="button"
        className="archive"
        title="Archive"
        aria-label={`Archive ${task.name}`}
        onClick={() => act(() => archiveTask(task.id))}
      >
        ×
      </button>

      {failure ? (
        <span className="row-error" role="alert">
          {failure}
        </span>
      ) : null}
    </div>
  );
}

function formatDue(value: string | null, hasTime: boolean) {
  if (!value) return { label: "—", overdue: false, empty: true };
  const date = new Date(value);
  return {
    label: date.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      ...dateFrame(hasTime),
    }),
    overdue: isOverdue(value, hasTime),
    empty: false,
  };
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function avatarColor(name: string) {
  const hues = [
    "var(--avatar-1)",
    "var(--avatar-2)",
    "var(--avatar-3)",
    "var(--avatar-4)",
    "var(--avatar-5)",
  ];
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hues[hash % hues.length];
}
