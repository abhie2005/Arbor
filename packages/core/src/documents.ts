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

import type {
  InlineNode,
  LinkTarget,
  MentionCandidate,
  ParagraphNode,
  RichDoc,
} from "./richtext";
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

/**
 * A link as it sits inside a `Y.Text` (D-120).
 *
 * The second embed kind, and the one that proves the first was not a special
 * case: both are a non-text item occupying one position, and `blockString`
 * already spends one `EMBED_CHAR` on anything that is not a string — so the
 * editor's offsets needed no changes at all to carry a second kind.
 */
interface LinkEmbed {
  link: { kind: LinkTarget["kind"]; id: string; label: string };
}

function isLinkEmbed(value: unknown): value is LinkEmbed {
  if (typeof value !== "object" || value === null) return false;
  const embed = (value as LinkEmbed).link;
  return (
    typeof embed === "object" &&
    embed !== null &&
    (embed.kind === "page" || embed.kind === "task") &&
    typeof embed.id === "string" &&
    typeof embed.label === "string"
  );
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
    if (node.type === "link") {
      insertLink(text, text.length, node.target, node.label);
      continue;
    }
    insertMention(text, text.length, { id: node.userId, name: node.label });
  }
}

/**
 * A mention written into a paragraph, at an offset.
 *
 * **The embed's shape lives here and nowhere else** (invariant 7). Two call
 * sites build one now — a first draft parsed from plain text, and somebody
 * choosing a name from the editor's picker — and a second spelling of
 * `{ mention: { userId, label } }` would be a mention that `inlinesOf` skips
 * as an embed it does not recognise. Silently: the paragraph would render
 * without it and read back one character short.
 *
 * The label is stored beside the id for the reason `MentionNode` gives — it is
 * what the document said at the time, and re-resolving every mention through
 * the current user table would rewrite what people wrote (D-083).
 */
/**
 * A link written into a paragraph, at an offset.
 *
 * Beside `insertMention` and for the same reason: one place knows the embed's
 * shape, so a second spelling cannot produce an embed that `inlinesOf` skips
 * as unrecognised — which would render as nothing and read back one character
 * short.
 */
export function insertLink(
  text: Y.Text,
  at: number,
  target: LinkTarget,
  label: string,
): void {
  text.insertEmbed(at, {
    link: { kind: target.kind, id: target.id, label },
  } satisfies LinkEmbed);
}

export function insertMention(text: Y.Text, at: number, person: MentionCandidate): void {
  text.insertEmbed(at, {
    mention: { userId: person.id, label: person.name },
  } satisfies MentionEmbed);
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
      continue;
    }
    if (isLinkEmbed(op.insert)) {
      nodes.push({
        type: "link",
        target: { kind: op.insert.link.kind, id: op.insert.link.id },
        label: op.insert.link.label,
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
 * The origin stamped on every change this client makes itself.
 *
 * It is the difference between "I typed this" and "this arrived", and three
 * things read it: the editor pushes only local changes to the server, the pull
 * path applies remote ones under a *different* origin so they are not echoed
 * back, and the undo manager below tracks only this one. A change with no
 * origin is a bug — it would be both unpushed and un-undoable.
 */
export const LOCAL_ORIGIN = "local";

/** The origin for an update that came from somebody else, via the stream. */
export const REMOTE_ORIGIN = "remote";

/**
 * ⌘Z inside a document, as a Yjs undo manager (D-116).
 *
 * **What it is for.** D-111 decided that undo inside a document means *the text
 * you typed*, and that this is deliberately not the workspace undo stack: an
 * operation carries a `taskId`, a document carries a container, and two stacks
 * fighting over one keystroke is worse than a rename that is not undoable. What
 * it did not do is make that true — until this, ⌘Z in a paragraph was the
 * **textarea's** own history, which is private to that element and knows
 * nothing about a remote change that arrived between two keystrokes. Undoing
 * past one would resurrect text the CRDT had already moved on from.
 *
 * **Scoped to the blocks array, not to one paragraph.** Yjs tracks a type and
 * everything beneath it, so one manager covers every paragraph's `Y.Text` —
 * including paragraphs added after it was created, which matters because
 * `+ Paragraph` is itself an undoable change. A manager per textarea would mean
 * a stack per paragraph and no way to undo adding or removing one.
 *
 * **`trackedOrigins` is the whole safety property.** Only changes stamped
 * `LOCAL_ORIGIN` enter the stack, so ⌘Z can never reach into somebody else's
 * typing — a remote update is applied under `REMOTE_ORIGIN` and is invisible
 * here. Without this the manager would happily revert a colleague's sentence,
 * which is both astonishing and, in a CRDT, perfectly durable.
 *
 * The capture timeout is left at Yjs's default: changes within half a second
 * collapse into one entry, so a burst of typing is one ⌘Z rather than one per
 * character — which is what the diff in the editor produces.
 */
export function documentUndoManager(doc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager(doc.getArray(BLOCKS), {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
  });
}

/* ------------------------------------------------------------------ *
 * What an editing surface needs: a paragraph as a string, and offsets
 * in that string that mean something to the CRDT.
 * ------------------------------------------------------------------ */

/**
 * A mention, as one character.
 *
 * **This is the decision the editing surface turns on** (D-117). A paragraph
 * is a `Y.Text` holding text and embeds, and Yjs counts an embed as **one**
 * position — `text.length` of a paragraph that is nothing but a mention is 1.
 * So if the string an editor works in spends exactly one UTF-16 code unit on
 * each embed, a string offset and a `Y.Text` offset are *the same number*, and
 * everything downstream gets simple: the diff below needs no knowledge of
 * embeds, a caret is one integer, and `text.delete(at, n)` takes the offsets a
 * `Selection` reported without a conversion step that could be wrong.
 *
 * U+FFFC is OBJECT REPLACEMENT CHARACTER, which Unicode defines for exactly
 * this — the stand-in for an embedded object in a run of text. Picking a
 * character nobody types is the whole requirement; picking the one that is
 * *named* after the job means the next reader does not have to be told.
 */
export const EMBED_CHAR = "\uFFFC";

/**
 * One paragraph's inline nodes.
 *
 * The same projection `richTextFrom` does, for one block instead of a
 * document. An editor wants this rather than the whole tree: it repaints a
 * paragraph per keystroke, and `richTextFrom` takes an encoded update, so
 * asking it would mean encoding the entire document on every character.
 */
export function blockNodes(text: Y.Text): InlineNode[] {
  return inlinesOf(text);
}

/**
 * A paragraph as the string an editor edits.
 *
 * Reads the delta rather than `toString()`, because `Y.Text.toString()` drops
 * embeds entirely — a paragraph of "Ask @Riley about it" would come back as
 * "Ask  about it" and every offset after the mention would be one short. That
 * silent off-by-one is the bug this function exists to make impossible.
 */
export function blockString(text: Y.Text): string {
  let out = "";

  for (const op of text.toDelta() as { insert?: unknown }[]) {
    if (typeof op.insert === "string") out += op.insert;
    else if (op.insert !== undefined) out += EMBED_CHAR;
  }

  return out;
}

/**
 * Text as it is safe to insert — which is text with no `EMBED_CHAR` in it.
 *
 * A literal U+FFFC arriving from a paste would be stored as a character and
 * then read back by `blockString` as if it were a mention, so every offset
 * after it would address the wrong place while the paragraph looked fine. It
 * is not a character anybody means to type; dropping it is cheaper than
 * carrying the ambiguity.
 */
export function typeable(input: string): string {
  return input.includes(EMBED_CHAR) ? input.split(EMBED_CHAR).join("") : input;
}

/** One replaced range: what to delete at `at`, and what to insert there. */
export interface Replacement {
  at: number;
  removed: number;
  added: string;
}

/**
 * The single replaced range between two strings.
 *
 * Walks in from both ends. Everything between the common prefix and the common
 * suffix is what changed — which is one insert, one delete, or one of each, and
 * covers typing, backspacing, selecting-and-replacing and pasting without
 * needing to know which of those happened.
 *
 * **It is the whole trick** (D-112), and it did not change when the surface
 * did (D-117). Applying the range is a `delete` and an `insert` on the
 * `Y.Text`; replacing the paragraph wholesale would also "work" and would make
 * every edit conflict with every concurrent edit — two people typing in
 * different sentences of one paragraph would overwrite each other, which is
 * precisely what the CRDT was chosen to prevent. Because an embed is one
 * character here, a range that happens to span a mention deletes the mention
 * and nothing else needs to know.
 */
export function replacedRange(before: string, after: string): Replacement {
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

/** An `@` being typed: where it starts, and what has been typed after it. */
export interface MentionQuery {
  /** The offset of the `@` itself. */
  at: number;
  /** What follows it, up to the caret. */
  query: string;
}

/** The longest name a typeahead will chase before giving up. */
const MAX_QUERY = 40;

/**
 * Is the caret inside an `@` that has not been resolved yet?
 *
 * **Spaces are allowed in the query**, which looks wrong until you remember
 * that `parseRichText` matches the *longest* candidate name and names contain
 * spaces (D-083): a picker that stopped at the first space could never offer
 * "Riley Kaur". The query therefore runs from the `@` to the caret and is
 * filtered by substring, so it narrows as you type and closes on its own when
 * nothing matches.
 *
 * An `@` only counts at the start of the paragraph or after whitespace, so an
 * email address is not a mention attempt. A newline or an existing mention ends
 * the scan — you cannot mention somebody *through* either.
 */
export function mentionQuery(block: string, caret: number): MentionQuery | null {
  const from = Math.max(0, caret - MAX_QUERY - 1);

  for (let i = caret - 1; i >= from; i -= 1) {
    const char = block[i];
    if (char === undefined) return null;
    if (char === "\n" || char === EMBED_CHAR) return null;

    if (char === "@") {
      const before = i === 0 ? " " : block[i - 1]!;
      if (!/\s/.test(before)) return null;
      return { at: i, query: block.slice(i + 1, caret) };
    }
  }

  return null;
}

/** A `[[` being typed: where it starts, and what has been typed after it. */
export interface LinkQuery {
  /** The offset of the first `[`. */
  at: number;
  /** What follows the brackets, up to the caret. */
  query: string;
}

/**
 * Is the caret inside a `[[` that has not been resolved yet? (D-120)
 *
 * **Two brackets rather than one character**, because a single `[` is
 * punctuation somebody types in prose and `@` is not — a picker that opened on
 * every bracket would interrupt writing rather than help it. Two in a row is
 * rare enough to be a deliberate signal and is the convention a reader
 * arriving from any other wiki already knows.
 *
 * Unlike an `@`, a `[[` may begin anywhere: it is punctuation, so the
 * character before it says nothing about intent. A newline or an existing
 * embed still ends the scan — you cannot link *through* either.
 */
export function linkQuery(block: string, caret: number): LinkQuery | null {
  const from = Math.max(0, caret - MAX_QUERY - 2);

  for (let i = caret - 1; i > from; i -= 1) {
    const char = block[i];
    if (char === undefined) return null;
    if (char === "\n" || char === EMBED_CHAR) return null;
    // Closing brackets mean this one has already been finished with.
    if (char === "]") return null;

    if (char === "[" && block[i - 1] === "[") {
      return { at: i - 1, query: block.slice(i + 1, caret) };
    }
  }

  return null;
}

/**
 * The people an `@` query could mean, best first.
 *
 * Match is case-insensitive substring on the name, which is the same rule
 * `ILIKE` gives search (invariant 15) — one idea of what "matches" in an app
 * where a person could reasonably expect the two to agree. A name that
 * *starts* with the query is offered before one that merely contains it,
 * because that is the one somebody typing three letters usually means.
 */
export function mentionMatches(
  people: readonly MentionCandidate[],
  query: string,
  limit = 6,
): MentionCandidate[] {
  const needle = query.trim().toLowerCase();

  const scored = people
    .map((person) => ({ person, at: person.name.toLowerCase().indexOf(needle) }))
    .filter((hit) => hit.at >= 0);

  scored.sort((a, b) => a.at - b.at || a.person.name.localeCompare(b.person.name));

  return scored.slice(0, limit).map((hit) => hit.person);
}

/* ------------------------------------------------------------------ *
 * The page tree, as a walk.
 * ------------------------------------------------------------------ */

/** The little a page needs to have a place in the tree. */
export interface PageNode {
  id: string;
  parentPageId: string | null;
  position: string;
}

/** One row of the rendered tree. */
export interface PageWalkRow<T extends PageNode> {
  page: T;
  /** 0 for a root, 1 for its children, and so on. */
  depth: number;
  /** Whether anything hangs off it — what decides if there is a twisty. */
  hasChildren: boolean;
  /** Every ancestor's id, nearest last. A collapse hides anything naming it. */
  ancestors: string[];
}

/**
 * A flat list of pages, walked depth-first into the order they are drawn in.
 *
 * **The list cannot simply be rendered in the order it arrives.** `listDocs`
 * sorts by container and then `position`, and a child's position is drawn from
 * its own sibling sequence — so a child sorts against its parent's siblings,
 * not under its parent. Two levels of `paddingLeft` hid that for as long as
 * nothing had grandchildren. Ordering is a property of the tree, so it is
 * computed from the tree.
 *
 * **A page whose parent is missing is a root** (D-119). The list is permission
 * scoped: a reader may hold a grant on a subpage and none on the page above
 * it, and `listDocs` will return the child alone. Walking only from
 * `parentPageId === null` would drop it — a page somebody can open, absent
 * from the only screen that lists pages, with nothing on screen to say so.
 * Showing it at the root is the same "blunt in the safe direction" choice the
 * rest of the tree makes.
 *
 * **Cycles cannot hang this.** `moveDoc` refuses to make a page its own
 * ancestor, so a cycle would have to arrive from a direct write; a visited set
 * means the walk ends either way rather than running until the tab dies.
 */
export function pageWalk<T extends PageNode>(pages: readonly T[]): PageWalkRow<T>[] {
  const byParent = new Map<string | null, T[]>();
  const present = new Set(pages.map((page) => page.id));

  for (const page of pages) {
    // A parent that is not in this list cannot be walked from, so the child
    // stands at the root rather than disappearing with it.
    const key = page.parentPageId && present.has(page.parentPageId) ? page.parentPageId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), page]);
  }

  for (const siblings of byParent.values()) {
    // Position first; id breaks a tie so two pages written in the same
    // transaction do not swap places between renders.
    siblings.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1));
  }

  const rows: PageWalkRow<T>[] = [];
  const seen = new Set<string>();

  const visit = (page: T, depth: number, ancestors: string[]) => {
    if (seen.has(page.id)) return;
    seen.add(page.id);

    const children = byParent.get(page.id) ?? [];
    rows.push({ page, depth, hasChildren: children.length > 0, ancestors });

    const below = [...ancestors, page.id];
    for (const child of children) visit(child, depth + 1, below);
  };

  for (const root of byParent.get(null) ?? []) visit(root, 0, []);

  return rows;
}

/**
 * The rows that are visible, given which pages are collapsed.
 *
 * Collapsing hides descendants rather than children: a page three levels down
 * disappears with the ancestor that was closed, and reopening that ancestor
 * brings back whatever *its* own collapse state says, which is what makes the
 * twisties feel independent rather than nested.
 */
export function visibleRows<T extends PageNode>(
  rows: readonly PageWalkRow<T>[],
  collapsed: ReadonlySet<string>,
): PageWalkRow<T>[] {
  if (collapsed.size === 0) return [...rows];
  return rows.filter((row) => !row.ancestors.some((id) => collapsed.has(id)));
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
