"use client";

import { pageWalk, visibleRows } from "@arbor/core";
import type { DocRecord } from "@arbor/db";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import {
  archiveDocAction,
  createDocAction,
  moveDocAction,
  renameDocAction,
  repositionDocAction,
} from "@/server/doc-actions";
import type { DocPlace } from "@/server/docs";

import { DocEditor } from "./doc-editor";
import { useServerValue } from "./use-server-value";

/**
 * `/docs` — the page tree and whatever page is open.
 *
 * **The tree is a walk, not an indent.** `listDocs` returns pages ordered by
 * container and then `position`, and a child's position comes from its own
 * sibling sequence — so rendering that order puts a child among its parent's
 * siblings. `pageWalk` computes the drawing order from the tree instead
 * (D-119), at any depth, and it is pure and unit-tested in core because the
 * interesting cases are a missing parent and a cycle rather than anything
 * about React.
 *
 * **Dropping means two different things and the difference is where.** Onto a
 * row is "become its first child"; onto the strip below a row is "become its
 * next sibling". Both are one `repositionDocAction`, because `afterId` already
 * expresses both — the UI chooses the arguments, not a second server path.
 *
 * **Which page is open lives in the URL**, like every other selection in this
 * app (D-049). A link to a page is a link somebody can send.
 */

interface Props {
  docs: DocRecord[];
  places: DocPlace[];
  open: { doc: DocRecord; state: string } | null;
  viewerId: string;
  canCreateWorkspaceWide: boolean;
  /** Who the editor's `@` can mean. */
  people: { id: string; name: string }[];
  /** The pages pointing at whatever is open. */
  backlinks: { id: string; title: string; containerName: string | null }[];
}

export function Docs({
  docs,
  places,
  open,
  viewerId,
  canCreateWorkspaceWide,
  people,
  backlinks,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [placeId, setPlaceId] = useState<string>(places[0]?.id ?? "");
  /** Which page the next new page goes under, if any. */
  const [parentFor, setParentFor] = useState<DocRecord | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<{ id: string; mode: "into" | "after" } | null>(null);

  // Follows the server (D-090): a rename by somebody else arrives as a new
  // prop, and `useState(props.title)` would keep showing the old one.
  const [title, setTitle] = useServerValue(open?.doc.title ?? "");

  const run = (action: () => Promise<{ ok: boolean; error?: string }>) => {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? "That did not work");
      else setError(null);
      router.refresh();
    });
  };

  /**
   * A drop, as one call.
   *
   * `afterId` carries both meanings the UI offers: null places first under the
   * new parent (what dropping *onto* a row means), an id places directly after
   * that sibling (what dropping into the gap below it means).
   */
  const place = (docId: string, parentPageId: string | null, afterId: string | null) => {
    setDragId(null);
    setDropOn(null);
    run(() => repositionDocAction(docId, parentPageId, afterId));
  };

  // Whether to offer dragging at all. The server authorizes every reposition
  // regardless (invariant 4); this only decides whether the affordance is
  // there for somebody who could not use it anywhere.
  const canReorder = places.length > 0 || canCreateWorkspaceWide;

  const byContainer = new Map<string, DocRecord[]>();
  for (const doc of docs) {
    const key = doc.containerId ?? "";
    byContainer.set(key, [...(byContainer.get(key) ?? []), doc]);
  }

  const canEdit = open ? open.doc.containerId !== null || canCreateWorkspaceWide : false;

  return (
    <div className="docs">
      <aside className="docs-tree">
        <div className="docs-new">
          <input
            value={newTitle}
            placeholder={parentFor ? `New page under ${parentFor.title}` : "New page"}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setParentFor(null);
                return;
              }
              if (e.key !== "Enter" || newTitle.trim().length === 0) return;
              run(async () => {
                const result = await createDocAction(
                  parentFor ? parentFor.containerId : placeId || null,
                  newTitle.trim(),
                  parentFor?.id ?? null,
                );
                if (result.ok) {
                  setNewTitle("");
                  setParentFor(null);
                  router.push(`/docs?doc=${result.id}`);
                }
                return result;
              });
            }}
          />
          {parentFor ? (
            <button
              type="button"
              className="docs-parent-clear"
              onClick={() => setParentFor(null)}
              title="Make a top-level page instead"
            >
              under {parentFor.title} ×
            </button>
          ) : null}
          <select
            value={placeId}
            // A subpage inherits its parent's container, so there is nothing
            // to choose while one is selected — and offering the choice would
            // imply the two could disagree.
            disabled={parentFor !== null}
            onChange={(e) => setPlaceId(e.target.value)}
          >
            {canCreateWorkspaceWide ? <option value="">Workspace</option> : null}
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {" ".repeat(place.depth * 2)}
                {place.name}
              </option>
            ))}
          </select>
        </div>

        {[...byContainer.entries()].map(([containerId, pages]) => (
          <div className="docs-group" key={containerId || "workspace"}>
            <div className="docs-group-name">{pages[0]?.containerName ?? "Workspace"}</div>

            {visibleRows(pageWalk(pages), collapsed).map((row) => {
              const doc = row.page;
              const dragging = dragId === doc.id;
              // Refused here as well as on the server: a cycle is the one drop
              // whose refusal has to be visible before the mouse comes up.
              const illegal = dragId !== null && (dragging || row.ancestors.includes(dragId));

              return (
                <div key={doc.id}>
                  <div
                    className={[
                      "docs-row",
                      open?.doc.id === doc.id ? "is-open" : "",
                      dragging ? "is-dragging" : "",
                      dropOn?.id === doc.id && dropOn.mode === "into" ? "is-drop-into" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{ paddingLeft: 10 + row.depth * 14 }}
                    draggable={canReorder}
                    onDragStart={() => setDragId(doc.id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropOn(null);
                    }}
                    onDragOver={(event) => {
                      if (!dragId || illegal) return;
                      event.preventDefault();
                      setDropOn({ id: doc.id, mode: "into" });
                    }}
                    onDragLeave={() =>
                      setDropOn((at) =>
                        at?.id === doc.id && at.mode === "into" ? null : at,
                      )
                    }
                    onDrop={(event) => {
                      event.preventDefault();
                      if (!dragId || illegal) return;
                      place(dragId, doc.id, null);
                    }}
                  >
                    {row.hasChildren ? (
                      <button
                        type="button"
                        className="docs-twisty"
                        aria-expanded={!collapsed.has(doc.id)}
                        aria-label={collapsed.has(doc.id) ? "Expand" : "Collapse"}
                        onClick={() =>
                          setCollapsed((open) => {
                            const next = new Set(open);
                            if (!next.delete(doc.id)) next.add(doc.id);
                            return next;
                          })
                        }
                      >
                        {collapsed.has(doc.id) ? "▸" : "▾"}
                      </button>
                    ) : (
                      <span className="docs-twisty docs-twisty-none" aria-hidden="true" />
                    )}

                    <a className="docs-page" href={`/docs?doc=${doc.id}`}>
                      {doc.title}
                    </a>

                    {canReorder ? (
                      <button
                        type="button"
                        className="docs-subpage"
                        title={`Add a page under ${doc.title}`}
                        aria-label={`Add a page under ${doc.title}`}
                        onClick={() => {
                          setParentFor(doc);
                          setPlaceId(doc.containerId ?? "");
                        }}
                      >
                        +
                      </button>
                    ) : null}
                  </div>

                  {/* The gap below a row: drop here to become its next sibling. */}
                  <div
                    className={`docs-gap${
                      dropOn?.id === doc.id && dropOn.mode === "after" ? " is-drop-after" : ""
                    }`}
                    onDragOver={(event) => {
                      if (!dragId || dragId === doc.id) return;
                      event.preventDefault();
                      setDropOn({ id: doc.id, mode: "after" });
                    }}
                    onDragLeave={() =>
                      setDropOn((at) =>
                        at?.id === doc.id && at.mode === "after" ? null : at,
                      )
                    }
                    onDrop={(event) => {
                      event.preventDefault();
                      if (!dragId || dragId === doc.id) return;
                      place(dragId, doc.parentPageId, doc.id);
                    }}
                  />
                </div>
              );
            })}
          </div>
        ))}

        {docs.length === 0 ? <p className="docs-none">No pages yet.</p> : null}
      </aside>

      <section className="docs-page-body">
        {open ? (
          <>
            <header className="docs-head">
              <input
                className="docs-title"
                value={title}
                readOnly={!canEdit}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => {
                  const next = title.trim();
                  if (next.length === 0 || next === open.doc.title) return;
                  run(() => renameDocAction(open.doc.id, next));
                }}
              />
              <div className="docs-head-controls">
                <select
                  value={open.doc.containerId ?? ""}
                  disabled={!canEdit || pending}
                  onChange={(e) => run(() => moveDocAction(open.doc.id, e.target.value || null))}
                >
                  {canCreateWorkspaceWide ? <option value="">Workspace</option> : null}
                  {places.map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!canEdit || pending}
                  onClick={() => run(() => archiveDocAction(open.doc.id, true))}
                >
                  Archive
                </button>
              </div>
            </header>

            {error ? <p className="docs-error">{error}</p> : null}

            <DocEditor
              docId={open.doc.id}
              state={open.state}
              viewerId={viewerId}
              canEdit={canEdit}
              people={people}
            />

            {/* What points here. Absent rather than empty when nothing does —
                a heading over nothing reads as a feature that is broken. */}
            {backlinks.length > 0 ? (
              <section className="docs-backlinks">
                <h2>Linked from</h2>
                <ul>
                  {backlinks.map((source) => (
                    <li key={source.id}>
                      <a href={`/docs?doc=${source.id}`}>{source.title}</a>
                      <span>{source.containerName ?? "Workspace"}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : (
          <p className="docs-none">Nothing open. Pick a page, or make one.</p>
        )}
      </section>
    </div>
  );
}
