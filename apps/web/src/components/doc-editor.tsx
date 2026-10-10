"use client";

import {
  EMBED_CHAR,
  LOCAL_ORIGIN,
  REMOTE_ORIGIN,
  blockNodes,
  blockString,
  documentUndoManager,
  insertMention,
  mentionMatches,
  mentionQuery,
  replacedRange,
  typeable,
  type InlineNode,
  type MentionCandidate,
  type MentionNode,
} from "@arbor/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";

import { pullDocUpdate, pushDocUpdate } from "@/server/doc-actions";

/**
 * The editor.
 *
 * **A contenteditable per paragraph, and the per-paragraph part is the load-
 * bearing half** (D-117). The surface had to change because a mention is an
 * embed and a textarea can only hold text — a paragraph naming somebody was
 * read-only, which is half a document. What did *not* have to change is the
 * shape: one editing host per block rather than one for the whole document.
 * Two separate hosts cannot hold one selection, so a drag across three
 * paragraphs and a keystroke can never delete across blocks and leave the
 * browser to invent what the result is. The cost is that Backspace at the
 * start of a paragraph does nothing, which is listed as a gap rather than
 * hidden.
 *
 * **React renders the hosts; it does not render what is inside them.** The
 * children of an editable element are mutated by the browser on every
 * keystroke, and a reconciler that believed it owned them would fight the
 * person typing. So each host is rendered childless and painted imperatively
 * by an effect, and the paint is skipped whenever the DOM already says what the
 * document says — which is every local keystroke. A repaint happens only when
 * the text changed from somewhere else: a colleague, or ⌘Z.
 *
 * **The diff is still the whole trick** (D-112). The DOM is read back as a
 * string in which a mention is one `EMBED_CHAR`, so a string offset is a
 * `Y.Text` offset (D-117) and `replacedRange` applies unchanged — one delete
 * and one insert, never a wholesale replace, because a wholesale replace is
 * what makes two people in one paragraph clobber each other.
 *
 * **The caret is a relative position, not a number.** It is why ⌘Z no longer
 * drops the caret at the end of the paragraph, and why a sentence arriving
 * above where somebody is typing does not move them: a Yjs relative position
 * is anchored to the character rather than to the offset, so it survives both.
 * The undo stack carries one per entry, which is the pattern Yjs documents for
 * exactly this.
 *
 * **Enter is a newline, not a new block.** A stored paragraph already holds
 * newlines — that is what the textarea wrote and what `renderPlain` reads —
 * so Enter keeps meaning what it meant. Splitting a paragraph in two is a
 * different decision about what a block *is*, and it is not this change.
 *
 * **Paste is intercepted**, because the alternative is a browser inserting a
 * copied web page's markup into the editable and this reading it back as
 * flattened text — the styling silently discarded, and anything the DOM reader
 * does not recognise with it.
 */

/** How long to wait after typing stops before sending. */
const PUSH_AFTER_MS = 400;

/** The top-level array's name. It must match `documents.ts` in core. */
const BLOCKS = "blocks";

/** Where the caret was when an undo entry was created. */
const CARET = "caret";

interface Props {
  docId: string;
  /** The stored state, base64 — a Uint8Array does not survive JSON (D-097). */
  state: string;
  viewerId: string;
  canEdit: boolean;
  /** Who an `@` can mean: the workspace's members. */
  people: MentionCandidate[];
}

interface Block {
  id: number;
  /** The paragraph as a string, one `EMBED_CHAR` per mention. */
  value: string;
  nodes: InlineNode[];
}

/** An `@` the person is in the middle of typing. */
interface Picker {
  block: number;
  /** The offset of the `@`. */
  at: number;
  query: string;
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

/* ---------------------------- the DOM, read ---------------------------- */

/**
 * One host's children, each with the text it contributes.
 *
 * Everything that reads or writes a position goes through this, so there is
 * one answer to "how long is this node" rather than one per caller — and the
 * answer for a mention is 1, which is what makes a DOM offset a CRDT offset.
 */
function pieces(host: HTMLElement): { node: ChildNode; text: string }[] {
  const nodes = [...host.childNodes];

  return nodes.map((node, index) => ({
    node,
    text: pieceOf(node, index === nodes.length - 1),
  }));
}

function pieceOf(node: ChildNode, last: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";

  if (node instanceof HTMLElement) {
    if (node.dataset.mention !== undefined) return EMBED_CHAR;
    // A browser leaves a filler <br> at the end of an editable element rather
    // than let it collapse, and `white-space: pre-wrap` needs one to show a
    // trailing newline. A last-child <br> is therefore furniture, not a
    // character; one in the middle is a line break somebody made.
    if (node.tagName === "BR") return last ? "" : "\n";
    // Markup that should not be here — a paste that got past the handler, or a
    // browser's own idea of emphasis. Its text counts; its structure does not,
    // and the next paint removes it.
    return node.textContent ?? "";
  }

  return node.textContent ?? "";
}

/** What the DOM of one paragraph currently says. */
function domString(host: HTMLElement): string {
  return pieces(host)
    .map((part) => part.text)
    .join("");
}

/** Is this host's DOM only the things a paint produces? */
function painted(host: HTMLElement): boolean {
  return [...host.childNodes].every(
    (node) =>
      node.nodeType === Node.TEXT_NODE ||
      (node instanceof HTMLElement &&
        (node.dataset.mention !== undefined || node.tagName === "BR")),
  );
}

/** A DOM position, as an offset in the paragraph's string. */
function offsetOf(host: HTMLElement, container: Node, offset: number): number {
  const parts = pieces(host);

  // A selection anchored on the host itself counts whole children.
  if (container === host) {
    return parts.slice(0, offset).reduce((total, part) => total + part.text.length, 0);
  }

  let total = 0;
  for (const part of parts) {
    if (part.node === container) {
      return (
        total + (container.nodeType === Node.TEXT_NODE ? Math.min(offset, part.text.length) : 0)
      );
    }
    // Inside a mention — a click can land there even though it is not
    // editable. The caret belongs at its start, never halfway through a name.
    if (part.node.contains(container)) return total;
    total += part.text.length;
  }

  return total;
}

function selectionIn(host: HTMLElement): { from: number; to: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return null;

  const from = offsetOf(host, range.startContainer, range.startOffset);
  const to = offsetOf(host, range.endContainer, range.endOffset);

  return from <= to ? { from, to } : { from: to, to: from };
}

/* --------------------------- the DOM, written -------------------------- */

function mentionNode(node: MentionNode): HTMLElement {
  const span = document.createElement("span");
  span.className = "mention";
  // Not editable, so the browser treats the whole name as one thing: the
  // caret steps over it and Backspace takes all of it, which is what a
  // reference rather than a run of characters should feel like.
  span.contentEditable = "false";
  span.dataset.mention = node.userId;
  span.textContent = `@${node.label}`;
  return span;
}

function paint(host: HTMLElement, nodes: readonly InlineNode[]): void {
  const children: Node[] = nodes.map((node) =>
    node.type === "text" ? document.createTextNode(node.text) : mentionNode(node),
  );

  const last = nodes[nodes.length - 1];
  if (last?.type === "text" && last.text.endsWith("\n")) {
    children.push(document.createElement("br"));
  }

  host.replaceChildren(...children);
}

function placeCaret(host: HTMLElement, offset: number): void {
  const selection = window.getSelection();
  if (!selection) return;

  const range = document.createRange();
  let remaining = offset;
  let placed = false;

  for (const part of pieces(host)) {
    if (part.node.nodeType === Node.TEXT_NODE && remaining <= part.text.length) {
      range.setStart(part.node, remaining);
      placed = true;
      break;
    }
    if (remaining < part.text.length) {
      range.setStartBefore(part.node);
      placed = true;
      break;
    }
    remaining -= part.text.length;
  }

  if (placed) range.collapse(true);
  else {
    // Past the end, or an empty paragraph with nothing to anchor to.
    range.selectNodeContents(host);
    range.collapse(false);
  }

  selection.removeAllRanges();
  selection.addRange(range);
}

/* ------------------------------ the editor ----------------------------- */

export function DocEditor({ docId, state, viewerId, canEdit, people }: Props) {
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
  const [picker, setPicker] = useState<Picker | null>(null);
  const [highlight, setHighlight] = useState(0);

  const hosts = useRef<(HTMLDivElement | null)[]>([]);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sent = useRef<Uint8Array>(Y.encodeStateVector(ydoc));
  /** Where to put the caret after the next paint, if it has to move. */
  const restore = useRef<Y.RelativePosition | null>(null);
  /** An IME is mid-word: the DOM is not a document yet, so do not read it. */
  const composing = useRef(false);

  const matches = useMemo(
    () => (picker ? mentionMatches(people, picker.query) : []),
    [people, picker],
  );

  const blocksOf = useCallback(() => ydoc.getArray<Y.Map<unknown>>(BLOCKS), [ydoc]);

  const textAt = useCallback(
    (index: number): Y.Text | null => {
      const text = blocksOf().get(index)?.get("text");
      return text instanceof Y.Text ? text : null;
    },
    [blocksOf],
  );

  /** Rebuilds the visible blocks from the document. */
  const read = useCallback(() => {
    setBlocks(
      blocksOf()
        .toArray()
        .map((block, index) => {
          const text = block.get("text");
          const isText = text instanceof Y.Text;

          return {
            id: index,
            value: isText ? blockString(text) : "",
            nodes: isText ? blockNodes(text) : [],
          };
        }),
    );
  }, [blocksOf]);

  useEffect(() => {
    read();
  }, [read]);

  /** The caret as something that survives an edit from anywhere. */
  const captureCaret = useCallback((): Y.RelativePosition | null => {
    const index = hosts.current.findIndex((host) => host && host === document.activeElement);
    const host = index >= 0 ? hosts.current[index] : null;
    const text = index >= 0 ? textAt(index) : null;
    if (!host || !text) return null;

    const range = selectionIn(host);
    if (!range) return null;

    return Y.createRelativePositionFromTypeIndex(text, range.from);
  }, [textAt]);

  const restoreCaret = useCallback(
    (relative: Y.RelativePosition) => {
      const absolute = Y.createAbsolutePositionFromRelativePosition(relative, ydoc);
      if (!absolute) return;

      // Which paragraph the position belongs to: the one whose Y.Text it is.
      const index = blocksOf()
        .toArray()
        .findIndex((block) => block.get("text") === absolute.type);
      const host = index >= 0 ? hosts.current[index] : null;
      if (!host) return;

      if (document.activeElement !== host) host.focus({ preventScroll: true });
      placeCaret(host, absolute.index);
    },
    [blocksOf, ydoc],
  );

  /**
   * Paints what the document says, when the DOM does not already say it.
   *
   * The skip is not an optimisation. Repainting a host whose text is already
   * right would destroy the selection inside it on every keystroke, and
   * `replaceChildren` while an IME is composing would abandon the composition.
   */
  useEffect(() => {
    if (composing.current) return;

    blocks.forEach((block, index) => {
      const host = hosts.current[index];
      if (!host) return;
      if (domString(host) === block.value && painted(host)) return;
      paint(host, block.nodes);
    });

    const relative = restore.current;
    restore.current = null;
    if (relative) restoreCaret(relative);
  }, [blocks, restoreCaret]);

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
   * The caret rides on the undo stack.
   *
   * `stack-item-added` fires after the change, so what is stored is where the
   * edit *ended* — and that is the right anchor, because a relative position
   * whose characters are then deleted resolves to where they were. Undoing an
   * insert therefore lands the caret where the insert began rather than at the
   * end of the paragraph, which is the gap D-116 left open.
   */
  useEffect(() => {
    const onAdded = ({ stackItem }: { stackItem: { meta: Map<string, unknown> } }) => {
      const caret = captureCaret();
      if (caret) stackItem.meta.set(CARET, caret);
    };

    const onPopped = ({ stackItem }: { stackItem: { meta: Map<string, unknown> } }) => {
      const caret = stackItem.meta.get(CARET);
      if (caret) restore.current = caret as Y.RelativePosition;
    };

    undoManager.on("stack-item-added", onAdded);
    undoManager.on("stack-item-popped", onPopped);

    return () => {
      undoManager.off("stack-item-added", onAdded);
      undoManager.off("stack-item-popped", onPopped);
    };
  }, [captureCaret, undoManager]);

  /**
   * Someone else changed this document.
   *
   * The nudge says only *that* it changed (D-090), so this asks for the
   * difference against what this client holds and applies it. The caret is
   * captured first and restored after the paint, so an edit arriving above
   * somebody's cursor moves the text under them without moving them.
   */
  useEffect(() => {
    const onDocChange = (event: Event) => {
      const detail = (event as CustomEvent<{ docId: string; actorId: string }>).detail;
      if (detail.docId !== docId || detail.actorId === viewerId) return;

      void pullDocUpdate(docId, base64(Y.encodeStateVector(ydoc))).then((result) => {
        if (!result.ok) return;
        const update = bytes(result.update);
        if (update.length === 0) return;

        restore.current = captureCaret();
        Y.applyUpdate(ydoc, update, REMOTE_ORIGIN);
      });
    };

    window.addEventListener("arbor:doc", onDocChange);
    return () => window.removeEventListener("arbor:doc", onDocChange);
  }, [captureCaret, docId, viewerId, ydoc]);

  /* ----------------------------- editing ----------------------------- */

  /** Replaces whatever is selected in a paragraph with `chars`. */
  const replaceSelection = (index: number, chars: string) => {
    const host = hosts.current[index];
    const text = textAt(index);
    if (!host || !text) return;

    const end = blockString(text).length;
    const range = selectionIn(host) ?? { from: end, to: end };

    ydoc.transact(() => {
      if (range.to > range.from) text.delete(range.from, range.to - range.from);
      if (chars.length > 0) text.insert(range.from, chars);
    }, LOCAL_ORIGIN);

    restore.current = Y.createRelativePositionFromTypeIndex(text, range.from + chars.length);
    setPicker(null);
  };

  /** What the DOM now says, as one CRDT edit. */
  const absorb = (index: number) => {
    const host = hosts.current[index];
    const text = textAt(index);
    if (!host || !text) return;

    const next = domString(host);
    const before = blockString(text);

    if (before !== next) {
      const { at, removed, added } = replacedRange(before, next);
      const insert = typeable(added);

      ydoc.transact(() => {
        if (removed > 0) text.delete(at, removed);
        if (insert.length > 0) text.insert(at, insert);
      }, LOCAL_ORIGIN);
    }

    // The picker follows the caret rather than the keystroke, so it is right
    // after an arrow key and after a click as well as after typing.
    const range = selectionIn(host);
    const query = range && range.from === range.to ? mentionQuery(domString(host), range.from) : null;

    setPicker(query ? { block: index, ...query } : null);
    setHighlight(0);
  };

  const choose = (index: number, person: MentionCandidate) => {
    const host = hosts.current[index];
    const text = textAt(index);
    if (!host || !text || !picker || picker.block !== index) return;

    const range = selectionIn(host);
    const caret = range?.from ?? blockString(text).length;

    ydoc.transact(() => {
      // The `@` and what was typed after it become the embed.
      if (caret > picker.at) text.delete(picker.at, caret - picker.at);
      insertMention(text, picker.at, person);
      // A space after it, so the next keystroke is text rather than an
      // argument about whether the caret is inside the name.
      text.insert(picker.at + 1, " ");
    }, LOCAL_ORIGIN);

    restore.current = Y.createRelativePositionFromTypeIndex(text, picker.at + 2);
    setPicker(null);
  };

  const addBlock = () => {
    ydoc.transact(() => {
      const block = new Y.Map<unknown>();
      block.set("type", "paragraph");
      block.set("text", new Y.Text());
      blocksOf().push([block]);
    }, LOCAL_ORIGIN);
  };

  const removeBlock = (index: number) => {
    setPicker(null);
    ydoc.transact(() => blocksOf().delete(index, 1), LOCAL_ORIGIN);
  };

  /**
   * Keys the browser would otherwise answer for us.
   *
   * **⌘Z, and the `preventDefault` is the point** (D-116). Three stacks could
   * answer it and exactly one should: `undo.tsx` declines while focus is in an
   * editable, on the grounds that a typing person means their own text — which
   * is right, and here *their own text* is the CRDT's history rather than the
   * browser's. The browser's knows nothing about a remote edit that landed
   * between two keystrokes, so undoing past one would resurrect text the
   * document has moved on from.
   *
   * **Enter** is a newline in this paragraph (see the note at the top), unless
   * the picker is open, in which case it picks.
   */
  const onKeyDown = (index: number, event: React.KeyboardEvent<HTMLDivElement>) => {
    const open = picker?.block === index && matches.length > 0;

    if (open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((current) => (current + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((current) => (current - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const person = matches[highlight] ?? matches[0];
        if (person) choose(index, person);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPicker(null);
        return;
      }
    }

    if (event.key === "Enter") {
      event.preventDefault();
      replaceSelection(index, "\n");
      return;
    }

    if (!(event.metaKey || event.ctrlKey)) return;

    const key = event.key.toLowerCase();
    // ⌘Y is redo on Windows and Linux; ⌘⇧Z is redo everywhere.
    const redo = key === "y" || (key === "z" && event.shiftKey);
    if (key !== "z" && !redo) return;

    event.preventDefault();
    setPicker(null);
    if (redo) undoManager.redo();
    else undoManager.undo();
  };

  const onPaste = (index: number, event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const pasted = typeable(event.clipboardData.getData("text/plain"));
    if (pasted.length > 0) replaceSelection(index, pasted);
  };

  return (
    <div className="doc-body">
      {blocks.length === 0 ? (
        <p className="doc-empty">
          This page is empty.{canEdit ? " Add a paragraph to start writing." : ""}
        </p>
      ) : null}

      {blocks.map((block, index) => (
        <div className="doc-para" key={block.id}>
          <div
            className="doc-para-text"
            ref={(node) => {
              hosts.current[index] = node;
            }}
            // The children are painted by the effect above, never by React.
            contentEditable={canEdit}
            suppressContentEditableWarning
            role={canEdit ? "textbox" : undefined}
            aria-multiline={canEdit ? true : undefined}
            aria-label={canEdit ? `Paragraph ${index + 1}` : undefined}
            data-placeholder={canEdit && block.value.length === 0 ? "Write here" : undefined}
            onInput={() => {
              if (!composing.current) absorb(index);
            }}
            onKeyDown={(event) => onKeyDown(index, event)}
            onPaste={(event) => onPaste(index, event)}
            // A drop would insert markup the same way a paste does, and there
            // is nothing yet that a dropped thing should mean here.
            onDrop={(event) => event.preventDefault()}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
              absorb(index);
            }}
            onBlur={() => setPicker((current) => (current?.block === index ? null : current))}
          />

          {picker?.block === index && matches.length > 0 ? (
            <ul className="mention-picker" role="listbox" aria-label="People">
              {matches.map((person, position) => (
                <li key={person.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={position === highlight}
                    data-highlighted={position === highlight || undefined}
                    // Mousedown, not click: click fires after blur, and blur
                    // has already closed the picker by then — and preventing
                    // the default keeps the caret in the paragraph, which
                    // `choose` reads to know what the `@` query was.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(index, person);
                    }}
                  >
                    {person.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

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
      ))}

      {canEdit ? (
        <div className="doc-actions">
          <button type="button" onClick={addBlock}>
            + Paragraph
          </button>
          <span className="doc-hint">@ names somebody · ⌘Z takes back your own typing</span>
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
