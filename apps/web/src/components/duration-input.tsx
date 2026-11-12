"use client";

import { formatDuration, parseDuration } from "@arbor/core";
import { type KeyboardEvent, useState } from "react";

import { useServerValue } from "./use-server-value";

/**
 * A duration, written the way it is read (D-148).
 *
 * **Text rather than a number and a unit**, because `formatDuration` is already
 * the one vocabulary every screen *reads* a duration in, and a box that takes
 * back exactly what it shows is the only version with no translation step in
 * somebody's head. `parseDuration` is the other half, and it accepts a bare
 * number as minutes so the box that used to be labelled `min` still answers to
 * what people typed into it.
 *
 * **Only a readable draft is published.** Typing "2h 30m" passes through
 * "2h 3", which parses as nothing — publishing that as null would clear a
 * filter mid-keystroke. So the box holds its own text and the caller only hears
 * about values it can use, with `useServerValue`'s `hold` keeping a value that
 * arrives from elsewhere from yanking what is being typed (invariant 11).
 *
 * **`commitOn` is about who is listening, and it is the one knob here.** A
 * filter's receiver is component state and wants every readable keystroke, the
 * way the text and number boxes beside it behave. A task's estimate is a
 * *server write*, and a POST per keystroke is not an interface — that one
 * publishes once, when the box is left, which is what the control it replaced
 * already did.
 */
export function DurationInput({
  value,
  onChange,
  commitOn = "change",
  ariaLabel = "Value",
  className,
  placeholder = "2h 30m",
  onKeyDown,
}: {
  value: number | null;
  onChange: (ms: number | null) => void;
  commitOn?: "change" | "blur";
  ariaLabel?: string;
  className?: string;
  placeholder?: string;
  /** For a box inside a form somebody submits with Enter. */
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useServerValue(value === null ? "" : formatDuration(value), editing);

  return (
    <input
      type="text"
      aria-label={ariaLabel}
      className={className}
      placeholder={placeholder}
      value={text}
      onKeyDown={onKeyDown}
      onFocus={() => setEditing(true)}
      onChange={(event) => {
        setText(event.target.value);
        if (commitOn !== "change") return;
        const parsed = parseDuration(event.target.value);
        if (parsed !== null) onChange(parsed);
      }}
      onBlur={() => {
        setEditing(false);

        // An emptied box means "no estimate", which is a value rather than an
        // unreadable draft — but only on blur, because every duration is empty
        // for one keystroke on its way to being typed.
        const trimmed = text.trim();
        const parsed = trimmed === "" ? null : parseDuration(trimmed);

        if (commitOn === "blur" && (trimmed === "" || parsed !== null) && parsed !== value) {
          onChange(parsed);
          return;
        }

        // Back to the canonical spelling of whatever was understood, so "90"
        // reads as "1h 30m" afterwards and an unreadable draft does not sit
        // there looking like the value that is in force.
        setText(value === null ? "" : formatDuration(value));
      }}
    />
  );
}
