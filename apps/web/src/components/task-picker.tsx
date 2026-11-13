"use client";

import { useEffect, useRef, useState } from "react";

import { type TaskOption, namedTasks, taskCandidates } from "@/server/view-actions";

/**
 * The one value control that is a query rather than a menu (D-149).
 *
 * **Every other picker is a closed set.** Statuses, people, tags, lists — they
 * arrive with the page because a workspace has tens or hundreds of each, and
 * `optionsFor` hands them to a `<select>`. Tasks are the input that broke that
 * shape: there are thousands, so the options cannot be shipped, and until now
 * `input: "task"` fell through to a text box whose only valid content was a
 * uuid. That is what "a task picker nobody has built" meant — the declaration
 * was five years ahead of the control.
 *
 * So it asks the server as it is typed, debounced, with a stale guard: answers
 * can arrive out of order, and a slow response for "au" landing after a fast
 * one for "auth" would replace the right list with a wrong one. Both are the
 * same decisions the `[[` menu made (D-120), and the list it draws is the same
 * `.mention-picker` that menu and the comment box draw.
 *
 * **It shows what it is pointing at, which is the other half of the gap.** A
 * stored condition is a uuid; the box asks `namedTasks` what that uuid is
 * called. An id the viewer cannot reach resolves to nothing and is shown as
 * itself — the control has no business saying whether it exists (invariant 6).
 */
export function TaskPicker({
  value,
  onChange,
  onPick,
  ariaLabel = "Value",
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  /**
   * What was picked, not only its id (D-150).
   *
   * A caller that has to *say* what the value is — the automations screen's
   * one-sentence preview — would otherwise print a uuid until the rule was
   * saved and the page resolved it. The picker already knows the label; this
   * is it handing it over.
   */
  onPick?: (option: TaskOption) => void;
  ariaLabel?: string;
}) {
  const id = typeof value === "string" ? value : "";

  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<TaskOption[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const box = useRef<HTMLInputElement>(null);

  // What the current id is called, asked once per id. A miss stays a miss:
  // re-asking on every render for a task that was deleted or was never visible
  // is a request per keystroke somewhere else on the page.
  useEffect(() => {
    if (id === "" || id in labels) return;

    let current = true;
    void namedTasks([id]).then((result) => {
      if (!current || !result.ok) return;
      setLabels((known) => ({ ...known, [id]: result.tasks[0]?.label ?? id }));
    });

    return () => {
      current = false;
    };
  }, [id, labels]);

  useEffect(() => {
    if (!open) return;

    let current = true;
    const timer = setTimeout(() => {
      void taskCandidates(term).then((result) => {
        if (!current) return;
        setHits(result.ok ? result.tasks : []);
        setHighlight(0);
      });
    }, 150);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [term, open]);

  const choose = (option: TaskOption) => {
    setLabels((known) => ({ ...known, [option.id]: option.label }));
    onPick?.(option);
    onChange(option.id);
    setOpen(false);
    setTerm("");
    box.current?.blur();
  };

  // Closed, the box reads as the value it holds; open, it reads as what is
  // being typed. One input rather than a chip and a search field, because the
  // thing being replaced was one box and a filter row has no room for two.
  const shown = open ? term : id === "" ? "" : (labels[id] ?? id);

  return (
    <span className="task-picker">
      <input
        ref={box}
        type="text"
        aria-label={ariaLabel}
        className="task-picker-input"
        placeholder="Search tasks"
        value={shown}
        onFocus={() => {
          setOpen(true);
          setTerm("");
        }}
        onChange={(event) => setTerm(event.target.value)}
        onKeyDown={(event) => {
          if (!open || hits.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setHighlight((current) => (current + 1) % hits.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlight((current) => (current - 1 + hits.length) % hits.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            const option = hits[highlight];
            if (option) choose(option);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
        onBlur={() => setOpen(false)}
      />

      {open && hits.length > 0 ? (
        <ul className="mention-picker" role="listbox" aria-label="Tasks">
          {hits.map((option, position) => (
            <li key={option.id}>
              <button
                type="button"
                role="option"
                aria-selected={position === highlight}
                data-highlighted={position === highlight || undefined}
                // Mousedown, not click: click fires after blur, and blur has
                // already closed the list by then.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(option);
                }}
              >
                {option.label}
                <span className="mention-hint">{option.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
}
