"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { createTask } from "@/server/actions";

import { useUndo } from "./undo";

/**
 * Inline creation.
 *
 * The row stays open and refocuses after each save, so a burst of tasks is one
 * continuous typing motion: type, Enter, type, Enter. Closing the input after
 * every save is the single most common way this interaction gets ruined.
 */
export function NewTaskRow({
  listId,
  statusId,
  statusLabel,
}: {
  listId: string;
  statusId: string | null;
  statusLabel: string;
}) {
  const { record } = useUndo();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setOpen(false);
      return;
    }

    setName("");
    startTransition(async () => {
      const inverse = await createTask(listId, trimmed, statusId);
      record(inverse as never);
      input.current?.focus();
    });
  }

  if (!open) {
    return (
      <button type="button" className="new-task-trigger" onClick={() => setOpen(true)}>
        <span aria-hidden>+</span> Add task to {statusLabel}
      </button>
    );
  }

  return (
    <div className="row new-task" data-pending={pending || undefined}>
      <span className="dot" data-group="none" />
      <span className="key">—</span>
      <input
        ref={input}
        className="title-input"
        placeholder={`New task in ${statusLabel}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setName("");
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (!name.trim()) setOpen(false);
        }}
      />
    </div>
  );
}
