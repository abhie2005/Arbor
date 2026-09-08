/**
 * The document format comments and descriptions are stored in.
 *
 * **A block tree, chosen before anything needed one.** The obvious first move
 * is a plain string: a comment box is a textarea, and a string round-trips
 * through `jsonb` fine. The reason not to is mentions. A mention is a
 * *reference to a user*, and the moment it is stored as the characters
 * "@Riley Kaur" the reference is gone — renaming Riley rewrites history, two
 * Rileys are indistinguishable, and notification fan-out has to re-parse prose
 * to find out who was named. Storing a node with an id costs nothing now and
 * cannot be retrofitted later without a migration over every comment ever
 * written.
 *
 * **The input is still a textarea.** The format is what is stored, not what is
 * typed. `parseRichText` turns plain text plus the list of people who could be
 * meant into this tree, and `renderPlain` turns it back. No editor, no
 * contenteditable, no dependency — and when Phase 9 brings a real editor for
 * Docs, it adopts this shape rather than replacing it.
 *
 * `descriptions` use the same format for the same reason, which is why there
 * is one module rather than one per surface.
 */

export class RichTextError extends Error {}

export interface TextNode {
  type: "text";
  text: string;
}

/**
 * The label is stored alongside the id, deliberately duplicating the user's
 * name. It is what the comment said at the time — a display that re-resolved
 * every mention through the current user table would rewrite what people wrote
 * when someone changes their name, and a mention of a deleted user would
 * become a blank. The id is the reference; the label is the record.
 */
export interface MentionNode {
  type: "mention";
  userId: string;
  label: string;
}

export type InlineNode = TextNode | MentionNode;

export interface ParagraphNode {
  type: "paragraph";
  content: InlineNode[];
}

export interface RichDoc {
  type: "doc";
  content: ParagraphNode[];
}

export const EMPTY_DOC: RichDoc = { type: "doc", content: [] };

/** Someone who can be mentioned. Names, not just ids, because @ matches names. */
export interface MentionCandidate {
  id: string;
  name: string;
}

const MAX_LENGTH = 20_000;

/**
 * Plain text in, document out.
 *
 * Paragraphs split on a blank line, which is the convention every plain-text
 * box already trains people in. Single newlines stay inside a paragraph as
 * spaces rather than becoming paragraphs of their own, so a wrapped line is one
 * thought rather than three.
 *
 * **Mentions match the longest candidate name.** Names contain spaces, so `@`
 * followed by one word is not enough: "@Riley Kaur" has to beat "@Riley" when
 * both could match. Longest-first also makes "@Sam Petrov" unambiguous when a
 * "Sam" exists.
 *
 * **A name two people share is left as text.** There is no correct id to
 * choose, and picking one silently would notify the wrong person — which is
 * worse than the mention not resolving, because nothing on screen would say it
 * had happened.
 */
export function parseRichText(input: string, people: readonly MentionCandidate[]): RichDoc {
  if (input.length > MAX_LENGTH) {
    throw new RichTextError(`A comment may be at most ${MAX_LENGTH} characters`);
  }

  const byName = new Map<string, MentionCandidate | "ambiguous">();
  for (const person of people) {
    const existing = byName.get(person.name);
    byName.set(person.name, existing === undefined ? person : "ambiguous");
  }

  // Longest first, so "Riley Kaur" is tried before "Riley".
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);

  const paragraphs = input
    .split(/\n[ \t]*\n+/)
    .map((block) => block.replace(/\s*\n\s*/g, " ").trim())
    .filter((block) => block.length > 0);

  return {
    type: "doc",
    content: paragraphs.map((text) => ({ type: "paragraph", content: inlines(text, names, byName) })),
  };
}

function inlines(
  text: string,
  names: readonly string[],
  byName: ReadonlyMap<string, MentionCandidate | "ambiguous">,
): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer.length > 0) {
      nodes.push({ type: "text", text: buffer });
      buffer = "";
    }
  };

  let index = 0;
  while (index < text.length) {
    if (text[index] !== "@") {
      buffer += text[index];
      index += 1;
      continue;
    }

    const rest = text.slice(index + 1);
    const matched = names.find((name) => rest.startsWith(name));
    const candidate = matched === undefined ? undefined : byName.get(matched);

    if (matched === undefined || candidate === undefined || candidate === "ambiguous") {
      // Either nobody by that name, or two people with it. The "@" stays as
      // typed — an unresolved mention has to look unresolved.
      buffer += "@";
      index += 1;
      continue;
    }

    flush();
    nodes.push({ type: "mention", userId: candidate.id, label: candidate.name });
    index += 1 + matched.length;
  }

  flush();
  return nodes;
}

/**
 * The document as plain text, mentions included as "@Name".
 *
 * Used for the notification payload, which the schema requires to be a
 * *rendered* summary so an inbox row needs no joins — and eventually for
 * search, which cannot index a tree.
 */
export function renderPlain(doc: RichDoc): string {
  return doc.content
    .map((paragraph) =>
      paragraph.content
        .map((node) => (node.type === "mention" ? `@${node.label}` : node.text))
        .join(""),
    )
    .join("\n\n");
}

/** Every user named in the document, deduplicated. The fan-out list. */
export function mentionedIds(doc: RichDoc): string[] {
  const ids = new Set<string>();
  for (const paragraph of doc.content) {
    for (const node of paragraph.content) {
      if (node.type === "mention") ids.add(node.userId);
    }
  }
  return [...ids];
}

export function isEmptyDoc(doc: RichDoc): boolean {
  return renderPlain(doc).trim().length === 0;
}

/**
 * A document read back out of `jsonb`, validated.
 *
 * **Stored JSON is untrusted input.** It was written by a client at some point,
 * and by a *different version* of this code at some point after that. A
 * renderer that walks it without checking crashes a whole page on one malformed
 * row; this returns null and lets the caller show that one comment as
 * unreadable. Same rule as a view definition going through the compiler rather
 * than being trusted because it came from the database (D-018).
 */
export function parseStoredDoc(value: unknown): RichDoc | null {
  if (typeof value !== "object" || value === null) return null;

  const doc = value as { type?: unknown; content?: unknown };
  if (doc.type !== "doc" || !Array.isArray(doc.content)) return null;

  const content: ParagraphNode[] = [];

  for (const block of doc.content) {
    if (typeof block !== "object" || block === null) return null;
    const paragraph = block as { type?: unknown; content?: unknown };
    if (paragraph.type !== "paragraph" || !Array.isArray(paragraph.content)) return null;

    const inline: InlineNode[] = [];
    for (const item of paragraph.content) {
      if (typeof item !== "object" || item === null) return null;
      const node = item as { type?: unknown; text?: unknown; userId?: unknown; label?: unknown };

      if (node.type === "text" && typeof node.text === "string") {
        inline.push({ type: "text", text: node.text });
        continue;
      }
      if (
        node.type === "mention" &&
        typeof node.userId === "string" &&
        typeof node.label === "string"
      ) {
        inline.push({ type: "mention", userId: node.userId, label: node.label });
        continue;
      }
      return null;
    }

    content.push({ type: "paragraph", content: inline });
  }

  return { type: "doc", content };
}
