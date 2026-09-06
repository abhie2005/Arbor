"use client";

import type { ViewDefinition } from "@arbor/core";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  deleteViewAction,
  duplicateViewAction,
  renameViewAction,
  saveViewDefinitionAction,
  setDefaultViewAction,
} from "@/server/view-actions";

/**
 * The tab strip is the list of saved views, not the list of renderer types.
 *
 * That distinction is the whole point of a view being a saved query plus a
 * renderer (D-017): two boards over the same list with different filters are
 * two tabs, and "Board" is not a tab at all — it is a property of one.
 *
 * A renderer with no saved view is still shown, greyed, because the compiler
 * already produces everything it would need and hiding the gap would suggest
 * the product is only a list and a board.
 */

export interface ViewTab {
  id: string;
  name: string;
  type: string;
  isDefault: boolean;
  personal: boolean;
}

const RENDERER_ROUTE: Record<string, string> = { list: "/", board: "/board", table: "/table" };
const UNBUILT = ["Calendar"];

export function ViewTabs({
  views,
  currentViewId,
  definition,
  savedDefinition,
  dirty,
}: {
  views: ViewTab[];
  currentViewId: string | null;
  definition: ViewDefinition;
  savedDefinition: ViewDefinition;
  dirty: boolean;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);

  // Computed on the server, which is the only side that knows which parts of a
  // definition the *renderer* overrides — the list forces showSubtasks to 3 and
  // the board to 1, and neither is a change the user made.

  function run(action: () => Promise<{ ok: true; id?: string } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMenuFor(null);
      router.refresh();
    });
  }

  function hrefFor(view: ViewTab) {
    const route = RENDERER_ROUTE[view.type] ?? "/";
    const query = new URLSearchParams(params.toString());
    query.set("view", view.id);
    // A saved view carries its own filters; keeping the previous tab's `f`
    // would silently apply one view's filter to another.
    query.delete("f");
    return `${route}?${query.toString()}`;
  }

  return (
    <>
      <div className="tabs">
        {views.map((view) => {
          const active = view.id === currentViewId;
          return (
            <span className="tab-wrap" key={view.id}>
              <Link
                className="tab"
                href={hrefFor(view)}
                aria-current={active ? "page" : undefined}
                title={view.personal ? "Only you can see this view" : undefined}
              >
                {view.name}
                {view.personal ? <span className="tab-mark">·</span> : null}
              </Link>

              {active ? (
                <button
                  type="button"
                  className="tab-menu"
                  onClick={() => setMenuFor(menuFor === view.id ? null : view.id)}
                  title="View options"
                >
                  ⌄
                </button>
              ) : null}

              {menuFor === view.id ? (
                <ViewMenu
                  view={view}
                  onClose={() => setMenuFor(null)}
                  onRename={(name) => run(() => renameViewAction(view.id, name))}
                  onDefault={() => run(() => setDefaultViewAction(view.id))}
                  onDelete={() => run(() => deleteViewAction(view.id))}
                />
              ) : null}
            </span>
          );
        })}

        {UNBUILT.map((label) => (
          <span key={label} className="tab" data-unbuilt title="Not built yet">
            {label}
          </span>
        ))}

        {dirty && currentViewId ? (
          <span className="tab-dirty" data-pending={pending || undefined}>
            <span>Unsaved filter</span>
            <button
              type="button"
              onClick={() =>
                run(() =>
                  saveViewDefinitionAction(currentViewId, {
                    ...savedDefinition,
                    filters: definition.filters,
                  }),
                )
              }
            >
              Save
            </button>
            {newName === null ? (
              <button type="button" onClick={() => setNewName("")}>
                Save as new
              </button>
            ) : (
              // Inline, not a browser prompt(): a modal dialog blocks the page
              // and cannot be styled, tested, or dismissed with Escape.
              <input
                className="tab-name-input"
                autoFocus
                placeholder="Name the new view"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setNewName(null);
                  if (event.key !== "Enter" || !newName.trim()) return;
                  run(() =>
                    duplicateViewAction(
                      currentViewId,
                      newName,
                      { ...savedDefinition, filters: definition.filters },
                      true,
                    ),
                  );
                  setNewName(null);
                }}
              />
            )}
            <Link className="tab-reset" href={RENDERER_ROUTE[typeOf(views, currentViewId)] ?? "/"}>
              Reset
            </Link>
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="tab-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function typeOf(views: ViewTab[], id: string | null): string {
  return views.find((v) => v.id === id)?.type ?? "list";
}

function ViewMenu({
  view,
  onClose,
  onRename,
  onDefault,
  onDelete,
}: {
  view: ViewTab;
  onClose: () => void;
  onRename: (name: string) => void;
  onDefault: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(view.name);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="tab-popover">
      <input
        className="settings-input"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && name.trim() && name !== view.name) onRename(name);
          if (event.key === "Escape") onClose();
        }}
      />

      {!view.isDefault && !view.personal ? (
        <button type="button" onClick={onDefault}>
          Make default
        </button>
      ) : null}

      {confirming ? (
        <button type="button" className="danger" onClick={onDelete}>
          Really delete
        </button>
      ) : (
        <button type="button" className="danger" onClick={() => setConfirming(true)}>
          Delete view
        </button>
      )}

      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
