"use client";

import type { DocRecord } from "@arbor/db";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  archiveDocAction,
  createDocAction,
  moveDocAction,
  renameDocAction,
} from "@/server/doc-actions";
import type { DocPlace } from "@/server/docs";

import { DocEditor } from "./doc-editor";
import { useServerValue } from "./use-server-value";

/**
 * `/docs` — the page tree and whatever page is open.
 *
 * **The tree is the list, indented.** `listDocs` returns pages ordered by
 * container and then position, so the shape on screen is a walk over that
 * rather than a second sort here — one order, decided where the permission
 * scoping already happens.
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
}

export function Docs({ docs, places, open, viewerId, canCreateWorkspaceWide }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [placeId, setPlaceId] = useState<string>(places[0]?.id ?? "");

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
            placeholder="New page"
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || newTitle.trim().length === 0) return;
              run(async () => {
                const result = await createDocAction(placeId || null, newTitle.trim());
                if (result.ok) {
                  setNewTitle("");
                  router.push(`/docs?doc=${result.id}`);
                }
                return result;
              });
            }}
          />
          <select value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
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
            <div className="docs-group-name">
              {pages[0]?.containerName ?? "Workspace"}
            </div>
            {pages.map((doc) => (
              <a
                className={`docs-page${open?.doc.id === doc.id ? " is-open" : ""}`}
                href={`/docs?doc=${doc.id}`}
                key={doc.id}
                style={{ paddingLeft: doc.parentPageId ? 28 : 14 }}
              >
                {doc.title}
              </a>
            ))}
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
            />
          </>
        ) : (
          <p className="docs-none">Nothing open. Pick a page, or make one.</p>
        )}
      </section>
    </div>
  );
}
