/**
 * The collaborative half of a document: what is stored, and what everything
 * else reads instead of it.
 *
 * **Why a CRDT here and nowhere else.** ADR 4 split the product in two and this
 * is the other side of that line. A task's status is server-authoritative
 * because the server has to be able to refuse it; a paragraph two people are
 * typing in has no such rule, and the thing that matters is that neither of
 * them loses a keystroke. Yjs is the CRDT, named in ADR 4 before any of this
 * was written, and `docs.ydoc` has been waiting for it since migration 0000.
 *
 * **The document format did not change** (invariant 7). `richtext.ts` is still
 * the shape comments and descriptions are stored in, and the shape every reader
 * knows how to render; this module is the same tree expressed as Yjs types, so
 * an editor can operate on it concurrently. A block is a `Y.Map` with a
 * `Y.Text`, a mention is an *embed* inside that text carrying the user id — not
 * the characters "@Name", which is the mistake D-083 exists to prevent and
 * which a CRDT would have made permanent.
 *
 * **The projection is what the rest of the system reads.** Nothing outside an
 * editor should have to know Yjs: the fan-out asks who was mentioned, search
 * wants plain text, and a renderer wants the block tree it already renders.
 * `richTextFrom` is the one place that crosses over, and it is pure — a state
 * vector in, a `RichDoc` out, no document instance escaping.
 *
 * **Merging does not need a document.** `Y.mergeUpdates` combines binary
 * updates without instantiating anything, so a server that is only storing an
 * update never pays to load the document it belongs to. The projection does
 * load one, which is why it is computed on write rather than on read.
 */

import * as Y from "yjs";

import type { InlineNode, MentionCandidate, ParagraphNode, RichDoc } from "./richtext";
import { parseRichText, renderPlain } from "./richtext";

/** The name of the top-level array. Changing it orphans every document. */
const BLOCKS = "blocks";

/** Keys inside a block map. `type` is there so a second block kind can arrive. */
const TYPE = "type";
const TEXT = "text";

export class DocumentError extends Error {}

/**
 * A mention as it sits inside a `Y.Text`.
 *
 * Yjs calls these embeds: a non-text item in a text sequence, which is exactly
 * what a mention is. It carries the same two fields a `MentionNode` does, for
 * the same reason — the id is the reference and the label is what the document
 * said at the time (D-083).
 */
interface MentionEmbed {
  mention: { userId: string; label: string };
}

function isMentionEmbed(value: unknown): value is MentionEmbed {
  if (typeof value !== "object" || value === null) return false;
  const embed = (value as MentionEmbed).mention;
  return (
    typeof embed === "object" &&
    embed !== null &&
    typeof embed.userId === "string" &&
    typeof embed.label === "string"
  );
}

/**
 * A fresh document, encoded.
 *
 * An empty `Y.Doc` still encodes to a few bytes rather than to nothing, and
 * those bytes are a valid update — which means a new document and a document
 * whose blocks were all deleted are the same kind of thing, and no caller needs
 * to special-case null.
 */
export function emptyDocState(): Uint8Array {
  const doc = new Y.Doc();
  doc.getArray(BLOCKS);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

/**
 * Plain text in, document state out — the way a document gets a first draft.
 *
 * Reuses `parseRichText`, so paragraph splitting and mention resolution have
 * one implementation rather than one per surface, and a document pasted into a
 * doc resolves "@Riley Kaur" exactly as the same text would in a comment.
 */
export function docStateFromText(
  input: string,
  people: readonly MentionCandidate[] = [],
): Uint8Array {
  return docStateFrom(parseRichText(input, people));
}

/** The same, from a block tree that has already been parsed. */
export function docStateFrom(rich: RichDoc): Uint8Array {
  const doc = new Y.Doc();
  const blocks = doc.getArray<Y.Map<unknown>>(BLOCKS);

  doc.transact(() => {
    for (const paragraph of rich.content) {
      blocks.push([blockFrom(paragraph)]);
      fill(blocks.get(blocks.length - 1).get(TEXT) as Y.Text, paragraph);
    }
  });

  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

/**
 * An empty block. It is filled *after* it is in the document, not before.
 *
 * A `Y.Text` that has not been integrated yet buffers what it is told and
 * replays it on integration, and a run of inserts and embeds does not come back
 * out in the order it went in — a mention written last arrives first. Every
 * automated check still passes, because the text is all there; it is simply in
 * the wrong order. Build the structure, attach it, then write into it.
 */
function blockFrom(_paragraph: ParagraphNode): Y.Map<unknown> {
  const block = new Y.Map<unknown>();
  block.set(TYPE, "paragraph");
  block.set(TEXT, new Y.Text());
  return block;
}

function fill(text: Y.Text, paragraph: ParagraphNode): void {
  // Inserting at the end each time: `length` is in the text's own units, where
  // an embed counts as one, which is what makes a mention a single position to
  // a cursor rather than a run somebody can delete half of.
  for (const node of paragraph.content) {
    if (node.type === "text") {
      text.insert(text.length, node.text);
      continue;
    }
    text.insertEmbed(text.length, {
      mention: { userId: node.userId, label: node.label },
    } satisfies MentionEmbed);
  }
}

/**
 * The block tree a document currently says, for everything that is not an
 * editor.
 *
 * **Unreadable state is null, not a throw.** Same doctrine as `parseStoredDoc`:
 * the bytes were written by a client at some point and by an older version of
 * this code at some point after that, and one unreadable document should cost
 * that document rather than the page listing it.
 */
export function richTextFrom(state: Uint8Array): RichDoc | null {
  const doc = new Y.Doc();

  try {
    Y.applyUpdate(doc, state);

    const content: ParagraphNode[] = [];
    for (const block of doc.getArray<Y.Map<unknown>>(BLOCKS)) {
      if (!(block instanceof Y.Map)) return null;
      if (block.get(TYPE) !== "paragraph") return null;

      const text = block.get(TEXT);
      if (!(text instanceof Y.Text)) return null;

      content.push({ type: "paragraph", content: inlinesOf(text) });
    }

    return { type: "doc", content };
  } catch {
    return null;
  } finally {
    doc.destroy();
  }
}

function inlinesOf(text: Y.Text): InlineNode[] {
  const nodes: InlineNode[] = [];

  for (const op of text.toDelta() as { insert?: unknown }[]) {
    if (typeof op.insert === "string") {
      if (op.insert.length > 0) nodes.push({ type: "text", text: op.insert });
      continue;
    }
    if (isMentionEmbed(op.insert)) {
      nodes.push({
        type: "mention",
        userId: op.insert.mention.userId,
        label: op.insert.mention.label,
      });
    }
    // Anything else is an embed this version does not know about. Skipping it
    // keeps the rest of the paragraph readable, which is the point of having a
    // projection at all.
  }

  return nodes;
}

/**
 * What goes in `docs.search_text`.
 *
 * Maintained on write, because computing it needs a document instance and a
 * search that has to load every CRDT it might match is not a search.
 */
export function searchTextFrom(state: Uint8Array): string {
  const rich = richTextFrom(state);
  return rich ? renderPlain(rich) : "";
}

/**
 * One update folded into the stored state.
 *
 * **No document is instantiated**, deliberately: `Y.mergeUpdates` works on the
 * binary format, so accepting a keystroke costs a merge rather than a load, a
 * parse and an encode. A malformed update is refused here rather than being
 * merged into the state and taking the document with it — the whole point of
 * the CRDT is that the stored bytes stay readable.
 */
export function applyDocUpdate(state: Uint8Array, update: Uint8Array): Uint8Array {
  if (update.length === 0) throw new DocumentError("An empty update is not an update");

  try {
    return Y.mergeUpdates([state, update]);
  } catch (error) {
    throw new DocumentError(
      `That update is not readable as a document change: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * What a client is missing, given what it says it has.
 *
 * The other half of a sync: the client sends its state vector, and this returns
 * only the difference. It is what stops a document that has been edited for a
 * year from being sent in full to somebody opening it for the second time.
 */
export function diffFor(state: Uint8Array, clientStateVector: Uint8Array): Uint8Array {
  try {
    return Y.diffUpdate(state, clientStateVector);
  } catch (error) {
    throw new DocumentError(
      `That state vector is not readable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** The state vector of what is stored — small, and the thing a client asks for. */
export function stateVectorOf(state: Uint8Array): Uint8Array {
  return Y.encodeStateVectorFromUpdate(state);
}
