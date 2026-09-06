"use client";

import type { ColumnOption, ColumnSpec, ViewDefinition } from "@arbor/core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { saveViewDefinitionAction } from "@/server/view-actions";

/**
 * Choosing a table's columns.
 *
 * Unlike a filter or a sort, a column set is not exploration — it is what the
 * view *is* — so this writes straight to the saved view rather than layering
 * over it in the URL (D-066). There is no unsaved state to reconcile and no
 * banner to notice.
 *
 * Hiding a column keeps its entry, marked `hidden`, so its position and width
 * survive being switched off and back on. That is why the list is ordered by
 * the definition rather than alphabetically: what you reorder here is what you
 * see, including the parts currently switched off.
 */
export function ColumnMenu({
  viewId,
  definition,
  options,
}: {
  viewId: string | null;
  definition: ViewDefinition;
  options: ColumnOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // The definition's own order first, then everything not in it — so the menu
  // reads top to bottom as the table does, with the unused columns after.
  const inDefinition = definition.columns ?? [];
  const known = new Set(inDefinition.map((column) => String(column.field)));
  const rest = options.filter((option) => !known.has(String(option.ref)));
  const labels = new Map(options.map((option) => [String(option.ref), option.label]));

  function save(columns: ColumnSpec[]) {
    if (!viewId) {
      // Only a saved view has somewhere to put this. The fallback definition a
      // view-less renderer uses is a constant, and pretending to save into it
      // would lose the change on reload with no way to tell.
      setError("Save this view first — an unsaved view has nowhere to keep its columns.");
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await saveViewDefinitionAction(viewId, { ...definition, columns });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function toggle(ref: string) {
    const existing = inDefinition.find((column) => String(column.field) === ref);
    save(
      existing
        ? inDefinition.map((column) =>
            String(column.field) === ref ? { ...column, hidden: !column.hidden } : column,
          )
        : [...inDefinition, { field: ref as ColumnSpec["field"] }],
    );
  }

  function move(ref: string, by: -1 | 1) {
    const from = inDefinition.findIndex((column) => String(column.field) === ref);
    const to = from + by;
    if (from < 0 || to < 0 || to >= inDefinition.length) return;

    const next = [...inDefinition];
    const [moved] = next.splice(from, 1);
    if (moved) next.splice(to, 0, moved);
    save(next);
  }

  return (
    <div className="column-menu">
      <button
        type="button"
        className="column-menu-trigger"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        Columns
      </button>

      {open ? (
        <div className="column-popover" data-pending={pending || undefined}>
          {inDefinition.map((column, index) => {
            const ref = String(column.field);
            return (
              <div className="column-row" key={ref}>
                <label>
                  <input
                    type="checkbox"
                    checked={!column.hidden}
                    onChange={() => toggle(ref)}
                  />
                  {/* A column naming a deleted field still lists, so it can be
                      switched off or moved rather than being stuck invisible. */}
                  {labels.get(ref) ?? `${ref} (missing)`}
                </label>
                <span className="column-move">
                  <button
                    type="button"
                    onClick={() => move(ref, -1)}
                    disabled={index === 0}
                    aria-label={`Move ${labels.get(ref) ?? ref} left`}
                    title="Move left"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(ref, 1)}
                    disabled={index === inDefinition.length - 1}
                    aria-label={`Move ${labels.get(ref) ?? ref} right`}
                    title="Move right"
                  >
                    ↓
                  </button>
                </span>
              </div>
            );
          })}

          {rest.length > 0 ? (
            <>
              <div className="column-heading">Not shown</div>
              {rest.map((option) => (
                <div className="column-row" key={String(option.ref)}>
                  <label>
                    <input
                      type="checkbox"
                      checked={false}
                      onChange={() => toggle(String(option.ref))}
                    />
                    {option.label}
                    {option.custom ? <span className="column-custom">field</span> : null}
                  </label>
                </div>
              ))}
            </>
          ) : null}

          {error ? (
            <p className="column-error" role="alert">
              {error}
            </p>
          ) : null}

          <button type="button" className="column-close" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      ) : null}
    </div>
  );
}
