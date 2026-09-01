"use client";

import type { Operation } from "@arbor/core";
import { useEffect, useState, useTransition } from "react";

import { archiveTask, cycleStatus, renameTask, setPriority } from "@/server/actions";

import { useUndo } from "./undo";

export interface TaskRowData {
  id: string;
  key: string | null;
  name: string;
  priority: number | null;
  statusGroup: string | null;
  dueAt: string | null;
  assignees: string[];
  subtaskCount: number;
}

const PRIORITY_CYCLE = [null, 1, 2, 3, 4] as const;

export function TaskRow({ task }: { task: TaskRowData }) {
  const { record } = useUndo();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Optimistic name: the row shows the new value on keystroke and reconciles
  // when the server responds, rather than waiting for a round trip.
  const [name, setName] = useState(task.name);

  function run(action: () => Promise<Operation[]>) {
    startTransition(async () => {
      try {
        record(await action());
      } catch (error) {
        // The server is authoritative: drop the optimistic value and let the
        // revalidated render supply the truth. Surface the failure rather than
        // swallowing it — a silent catch here is why a broken mutation would
        // look like a UI that simply ignores clicks.
        setName(task.name);
        setFailure(error instanceof Error ? error.message : "That change did not save");
      }
    });
  }

  useEffect(() => {
    if (!failure) return;
    const timer = setTimeout(() => setFailure(null), 4000);
    return () => clearTimeout(timer);
  }, [failure]);

  const due = formatDue(task.dueAt);

  return (
    <div className="row" data-pending={pending || undefined} data-failed={failure ? true : undefined}>
      <button
        type="button"
        className="dot-button"
        title="Advance status"
        aria-label={`Advance status of ${task.name}`}
        onClick={() => run(() => cycleStatus(task.id))}
      >
        <span className="dot" data-group={task.statusGroup ?? undefined} />
      </button>

      <span className="key">{task.key ?? "—"}</span>

      {editing ? (
        <input
          className="title-input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (name.trim() && name !== task.name) run(() => renameTask(task.id, name));
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
        onClick={() => run(() => archiveTask(task.id))}
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

function formatDue(value: string | null) {
  if (!value) return { label: "—", overdue: false, empty: true };
  const date = new Date(value);
  return {
    label: date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" }),
    overdue: date.getTime() < Date.now(),
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
