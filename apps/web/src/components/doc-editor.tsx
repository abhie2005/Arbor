"use client";

import {
  LOCAL_ORIGIN,
  REMOTE_ORIGIN,
  documentUndoManager,
  richTextFrom,
  type RichDoc,
} from "@arbor/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";

import { pullDocUpdate, pushDocUpdate } from "@/server/doc-actions";

/**
 * The editor.
 *
 * **A textarea per paragraph, not a contenteditable.** The alternative is a
 * rich-text surface, which means owning selection, composition, paste
 * sanitising and a browser's own idea of what Enter does — a library's worth of
 * work for a first editor. A textarea already has all of that, correctly, and
 * the CRDT does not care what produced the change: what it needs is *which
 * characters moved*, and a diff of the text before and after says exactly that.
 *
 * **The diff is the whole trick** (D-112). On every change the paragraph's old
 * text and new text are compared from both ends, which yields one replaced
 * range, and that range is applied to the `Y.Text` as a delete and an insert.
 * Replacing the paragraph wholesale would also "work" and would make every edit
 * conflict with every concurrent edit — two people typing in different
 * sentences of one paragraph would overwrite each other, which is precisely
 * what the CRDT was chosen to prevent.
 *
 * **Mentions are read-only here, and say so.** A mention is an embed occupying
 * one position, and a textarea can only hold text — so a paragraph containing
 * one is rendered rather than edited, with a title explaining why, the same
 * choice the task page makes for the nine custom field types it cannot edit
 * yet. Editing the text around a mention is the next step and needs a surface
 * that can draw one.
 */

/** How long to wait after typing stops before sending. */
const PUSH_AFTER_MS = 400;

interface Props {
  docId: string;
  /** The stored state, base64 — a Uint8Array does not survive JSON (D-097). */
  state: string;
  viewerId: string;
  canEdit: boolean;
}

interface Block {
  id: number;
  text: string;
  /** A paragraph holding something a textarea cannot represent. */
  readOnly: boolean;
  rendered: RichDoc["content"][number] | null;
}

function bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function base64(input: Uint8Array): string {
  let binary = "";
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The single replaced range between two strings.
 *
 * Walks in from both ends. Everything between the common prefix and the common
 * suffix is what changed — which is one insert, one delete, or one of each, and
 * covers typing, backspacing, selecting-and-replacing and pasting without
 * needing to know which of those happened.
 */
function replacedRange(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }

  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1;
  }

  return {
    at: start,
    removed: before.length - start - end,
    added: after.slice(start, after.length - end),
  };
}

export function DocEditor({ docId, state, viewerId, canEdit }: Props) {
  // One Y.Doc for the life of this editor. It is the thing being edited; React
  // state is a view of it, rebuilt whenever it changes from any source.
  const ydoc = useMemo(() => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes(state));
    return doc;
    // Deliberately keyed to the document, not to `state`: a nudge that arrives
    // while someone is typing must not rebuild the document underneath them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  /**
   * ⌘Z for this document (D-116).
   *
   * Scoped to the blocks array and tracking only `LOCAL_ORIGIN`, both decided
   * in `documentUndoManager` where they are unit-tested. Lives as long as the
   * `Y.Doc` does, because an undo stack that reset on re-render would be a
   * stack you could not reach past the last keystroke.
   */
  const undoManager = useMemo(() => documentUndoManager(ydoc), [ydoc]);
  useEffect(() => () => undoManager.destroy(), [undoManager]);

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sent = useRef<Uint8Array>(Y.encodeStateVector(ydoc));

  /** Rebuilds the visible blocks from the document. */
  const read = useCallback(() => {
    const rich = richTextFrom(Y.encodeStateAsUpdate(ydoc));
    const array = ydoc.getArray<Y.Map<unknown>>("blocks");

    setBlocks(
      array.toArray().map((block, index) => {
        const paragraph = rich?.content[index] ?? null;
        const hasEmbed = paragraph?.content.some((node) => node.type === "mention") ?? false;
        const text = block.get("text");

        return {
          id: index,
          text: text instanceof Y.Text ? text.toString() : "",
          readOnly: hasEmbed,
          rendered: paragraph,
        };
      }),
    );
  }, [ydoc]);

  useEffect(() => {
    read();
  }, [read]);

  /**
   * Sends what this client has that the server does not.
   *
   * Debounced rather than per keystroke: a document write re-derives the
   * projection and the search text, and doing that per character would be a
   * write amplification nobody asked for. The state vector of what was last
   * sent is what makes the next send a difference rather than the whole
   * document.
   */
  const push = useCallback(() => {
    if (pending.current) clearTimeout(pending.current);

    pending.current = setTimeout(() => {
      const update = Y.encodeStateAsUpdate(ydoc, sent.current);
      if (update.length === 0) return;

      setStatus("saving");
      void pushDocUpdate(docId, base64(update)).then((result) => {
        if (result.ok) {
          sent.current = Y.encodeStateVector(ydoc);
          setStatus("saved");
          setError(null);
          return;
        }
        setStatus("error");
        setError(result.error);
      });
    }, PUSH_AFTER_MS);
  }, [docId, ydoc]);

  // Any change to the document — typed here, or arriving from somebody else —
  // rebuilds the blocks. Changes with a local origin are also pushed.
  useEffect(() => {
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      read();
      // An undo is a change like any other and has to be saved. Yjs stamps it
      // with the manager itself rather than with `LOCAL_ORIGIN`, so checking
      // only for the latter would leave ⌘Z visible on screen and absent from
      // the database until the next keystroke happened to flush it.
      if (origin === LOCAL_ORIGIN || origin === undoManager) push();
    };

    ydoc.on("update", onUpdate);
    return () => ydoc.off("update", onUpdate);
  }, [ydoc, push, read, undoManager]);

  /**
   * Someone else changed this document.
   *
   * The nudge says only *that* it changed (D-090), so this asks for the
   * difference against what this client holds and applies it. Applying an
   * update does not move a cursor that is not in the changed range, which is
   * why this can happen while somebody is typing.
   */
  useEffect(() => {
    const onDocChange = (event: Event) => {
      const detail = (event as CustomEvent<{ docId: string; actorId: string }>).detail;
      if (detail.docId !== docId || detail.actorId === viewerId) return;

      void pullDocUpdate(docId, base64(Y.encodeStateVector(ydoc))).then((result) => {
        if (!result.ok) return;
        const update = bytes(result.update);
        if (update.length > 0) Y.applyUpdate(ydoc, update, REMOTE_ORIGIN);
      });
    };

    window.addEventListener("arbor:doc", onDocChange);
    return () => window.removeEventListener("arbor:doc", onDocChange);
  }, [docId, viewerId, ydoc]);

  const blocksOf = () => ydoc.getArray<Y.Map<unknown>>("blocks");

  const edit = (index: number, next: string) => {
    const block = blocksOf().get(index);
    const text = block?.get("text");
    if (!(text instanceof Y.Text)) return;

    const { at, removed, added } = replacedRange(text.toString(), next);

    ydoc.transact(() => {
      if (removed > 0) text.delete(at, removed);
      if (added.length > 0) text.insert(at, added);
    }, LOCAL_ORIGIN);
  };

  const addBlock = () => {
    ydoc.transact(() => {
      const array = blocksOf();
      const block = new Y.Map<unknown>();
      block.set("type", "paragraph");
      block.set("text", new Y.Text());
      array.push([block]);
    }, LOCAL_ORIGIN);
  };

  const removeBlock = (index: number) => {
    ydoc.transact(() => blocksOf().delete(index, 1), LOCAL_ORIGIN);
  };

  /**
   * ⌘Z / ⌘⇧Z inside a paragraph, and the `preventDefault` is the point.
   *
   * **Three stacks could answer this keystroke and exactly one should** (D-116).
   * The workspace stack already declines: `undo.tsx` returns early when the
   * event's target is an input or a textarea, on the grounds that the browser's
   * text undo is what a typing user means. That reasoning is right for a
   * comment box and wrong here — the textarea's history is private to the
   * element and knows nothing about a remote edit that landed between two
   * keystrokes, so undoing past one resurrects text the document has moved on
   * from. So the default is suppressed and the CRDT's manager answers instead.
   *
   * Bound on the textarea rather than on the editor's root because that is the
   * target the workspace handler yields for. With focus outside a paragraph
   * there is no text to undo and ⌘Z keeps its workspace meaning, which is the
   * division D-111 drew.
   */
  const onParagraphKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.metaKey || event.ctrlKey)) return;

    const key = event.key.toLowerCase();
    // ⌘Y is redo on Windows and Linux; ⌘⇧Z is redo everywhere.
    const redo = key === "y" || (key === "z" && event.shiftKey);
    if (key !== "z" && !redo) return;

    event.preventDefault();
    if (redo) undoManager.redo();
    else undoManager.undo();
  };

  return (
    <div className="doc-body">
      {blocks.length === 0 ? (
        <p className="doc-empty">
          This page is empty.{canEdit ? " Add a paragraph to start writing." : ""}
        </p>
      ) : null}

      {blocks.map((block, index) =>
        block.readOnly ? (
          <div
            key={block.id}
            className="doc-para doc-para-locked"
            title="This paragraph names somebody. Editing text around a mention needs a surface that can draw one, and this one cannot yet."
          >
            {block.rendered?.content.map((node, i) =>
              node.type === "mention" ? (
                <span className="mention" key={i}>
                  @{node.label}
                </span>
              ) : (
                <span key={i}>{node.text}</span>
              ),
            )}
          </div>
        ) : (
          <div className="doc-para" key={block.id}>
            <textarea
              value={block.text}
              readOnly={!canEdit}
              rows={Math.max(1, block.text.split("\n").length)}
              placeholder={canEdit ? "Write here" : ""}
              onChange={(e) => edit(index, e.target.value)}
              onKeyDown={onParagraphKeyDown}
            />
            {canEdit ? (
              <button
                type="button"
                className="doc-para-remove"
                title="Remove this paragraph"
                aria-label="Remove this paragraph"
                onClick={() => removeBlock(index)}
              >
                ×
              </button>
            ) : null}
          </div>
        ),
      )}

      {canEdit ? (
        <div className="doc-actions">
          <button type="button" onClick={addBlock}>
            + Paragraph
          </button>
          <span className={`doc-status doc-status-${status}`}>
            {status === "saving" ? "Saving…" : status === "error" ? error : "Saved"}
          </span>
        </div>
      ) : (
        <div className="doc-actions">
          <span className="doc-status">Read only — you do not have edit here</span>
        </div>
      )}
    </div>
  );
}
