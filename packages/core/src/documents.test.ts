import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  DocumentError,
  EMBED_CHAR,
  LOCAL_ORIGIN,
  REMOTE_ORIGIN,
  applyDocUpdate,
  blockString,
  diffFor,
  docStateFrom,
  docStateFromText,
  documentUndoManager,
  emptyDocState,
  mentionMatches,
  mentionQuery,
  replacedRange,
  richTextFrom,
  searchTextFrom,
  stateVectorOf,
  typeable,
} from "./documents";
import { renderPlain } from "./richtext";

const RILEY = { id: "user-riley", name: "Riley Kaur" };

describe("a document's state", () => {
  it("starts empty and readable, rather than as nothing at all", () => {
    const rich = richTextFrom(emptyDocState());
    expect(rich).toEqual({ type: "doc", content: [] });
  });

  it("round-trips the block tree it was built from", () => {
    const state = docStateFromText("First thought.\n\nSecond one.", []);
    expect(renderPlain(richTextFrom(state)!)).toBe("First thought.\n\nSecond one.");
  });

  it("keeps a mention as a reference, not as the characters somebody typed", () => {
    // The whole reason the format is a tree (D-083): a CRDT storing "@Riley
    // Kaur" as text would make the mistake permanent and unmigratable.
    const state = docStateFromText("ping @Riley Kaur about this", [RILEY]);
    const paragraph = richTextFrom(state)!.content[0]!;

    expect(paragraph.content).toEqual([
      { type: "text", text: "ping " },
      { type: "mention", userId: "user-riley", label: "Riley Kaur" },
      { type: "text", text: " about this" },
    ]);
  });

  it("counts a mention as one position, so a cursor cannot land inside it", () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, docStateFromText("@Riley Kaur", [RILEY]));
    const text = doc.getArray<Y.Map<unknown>>("blocks").get(0)!.get("text") as Y.Text;

    expect(text.length).toBe(1);
    doc.destroy();
  });

  it("is what search reads, flattened", () => {
    const state = docStateFromText("Hiring plan\n\nAsk @Riley Kaur", [RILEY]);
    expect(searchTextFrom(state)).toBe("Hiring plan\n\nAsk @Riley Kaur");
  });
});

describe("two people editing at once", () => {
  /** Two clients that have both seen `base`, each making one change. */
  function twoEditors(base: Uint8Array) {
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, base);
    Y.applyUpdate(b, base);
    return { a, b };
  }

  it("merges into one document that kept both changes", () => {
    const base = docStateFromText("Shared line", []);
    const { a, b } = twoEditors(base);

    (a.getArray<Y.Map<unknown>>("blocks").get(0)!.get("text") as Y.Text).insert(0, "A: ");
    (b.getArray<Y.Map<unknown>>("blocks").get(0)!.get("text") as Y.Text).insert(11, " — B");

    let stored = base;
    stored = applyDocUpdate(stored, Y.encodeStateAsUpdate(a, Y.encodeStateVectorFromUpdate(base)));
    stored = applyDocUpdate(stored, Y.encodeStateAsUpdate(b, Y.encodeStateVectorFromUpdate(base)));

    const text = renderPlain(richTextFrom(stored)!);
    expect(text).toContain("A: ");
    expect(text).toContain("— B");
    a.destroy();
    b.destroy();
  });

  it("does not care what order the two updates arrive in", () => {
    // The property the whole choice rests on: the server can accept updates as
    // they land, without sequencing them.
    const base = docStateFromText("Order", []);
    const { a, b } = twoEditors(base);

    (a.getArray<Y.Map<unknown>>("blocks").get(0)!.get("text") as Y.Text).insert(5, " one");
    (b.getArray<Y.Map<unknown>>("blocks").get(0)!.get("text") as Y.Text).insert(0, "two ");

    const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVectorFromUpdate(base));
    const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVectorFromUpdate(base));

    const oneWay = applyDocUpdate(applyDocUpdate(base, fromA), fromB);
    const other = applyDocUpdate(applyDocUpdate(base, fromB), fromA);

    expect(renderPlain(richTextFrom(oneWay)!)).toBe(renderPlain(richTextFrom(other)!));
    a.destroy();
    b.destroy();
  });

  it("sends a returning client only what it is missing", () => {
    const base = docStateFromText("First", []);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, base);
    (doc.getArray<Y.Map<unknown>>("blocks").get(0)!.get("text") as Y.Text).insert(5, " and second");
    const stored = applyDocUpdate(base, Y.encodeStateAsUpdate(doc));

    const missing = diffFor(stored, stateVectorOf(base));
    expect(missing.length).toBeLessThan(stored.length);

    const client = new Y.Doc();
    Y.applyUpdate(client, base);
    Y.applyUpdate(client, missing);
    expect(renderPlain(richTextFrom(Y.encodeStateAsUpdate(client))!)).toBe("First and second");

    doc.destroy();
    client.destroy();
  });
});

describe("what the server refuses", () => {
  it("an empty update, which is a bug rather than a no-op", () => {
    expect(() => applyDocUpdate(emptyDocState(), new Uint8Array())).toThrow(DocumentError);
  });

  it("bytes that are not a Yjs update, rather than storing them", () => {
    // The stored state has to stay readable: merging garbage in is how one bad
    // request takes a document with it.
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 200, 255]);
    expect(() => applyDocUpdate(emptyDocState(), junk)).toThrow(DocumentError);
  });

  it("and a document that will not load reads as null, not as a crash", () => {
    expect(richTextFrom(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 200]))).toBeNull();
    expect(searchTextFrom(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 200]))).toBe("");
  });

  it("a block of a kind this version does not know", () => {
    const doc = new Y.Doc();
    const blocks = doc.getArray<Y.Map<unknown>>("blocks");
    const block = new Y.Map<unknown>();
    block.set("type", "whiteboard");
    blocks.push([block]);
    const state = Y.encodeStateAsUpdate(doc);
    doc.destroy();

    expect(richTextFrom(state)).toBeNull();
  });
});

describe("the tree it is built from", () => {
  it("accepts a RichDoc directly, so a description can become a document", () => {
    const state = docStateFrom({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Owner: " },
            { type: "mention", userId: "user-riley", label: "Riley Kaur" },
          ],
        },
      ],
    });

    expect(searchTextFrom(state)).toBe("Owner: @Riley Kaur");
  });
});

describe("documentUndoManager", () => {
  /** A document with one paragraph, the way the editor holds one. */
  function opened(text = "") {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, docStateFromText(text || "Hello", []));
    return doc;
  }

  const paragraph = (doc: Y.Doc, index = 0) =>
    doc.getArray<Y.Map<unknown>>("blocks").get(index).get("text") as Y.Text;

  /** What a keystroke in the editor does: a local-origin edit to the Y.Text. */
  const type = (doc: Y.Doc, at: number, chars: string, index = 0) =>
    doc.transact(() => paragraph(doc, index).insert(at, chars), LOCAL_ORIGIN);

  it("undoes text typed in a paragraph, which the array scope has to reach", () => {
    // The property the scope choice rests on: the manager is given the blocks
    // array, and the text lives in a Y.Text two levels below it.
    const doc = opened("Hello");
    const manager = documentUndoManager(doc);

    type(doc, 5, " world");
    expect(paragraph(doc).toString()).toBe("Hello world");

    manager.undo();
    expect(paragraph(doc).toString()).toBe("Hello");

    manager.redo();
    expect(paragraph(doc).toString()).toBe("Hello world");
    manager.destroy();
  });

  it("will not undo a change that arrived from somebody else", () => {
    // The safety property. A remote update is applied under REMOTE_ORIGIN, so
    // it must not be in the stack — ⌘Z reaching into a colleague's sentence is
    // both astonishing and, in a CRDT, durable.
    const mine = opened("Ours");
    const manager = documentUndoManager(mine);

    const theirs = new Y.Doc();
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine));
    theirs.transact(() => (paragraph(theirs).insert(4, " and theirs")), LOCAL_ORIGIN);
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs), REMOTE_ORIGIN);

    expect(paragraph(mine).toString()).toBe("Ours and theirs");
    expect(manager.canUndo()).toBe(false);

    manager.undo();
    expect(paragraph(mine).toString()).toBe("Ours and theirs");
    manager.destroy();
  });

  it("undoes only my half when both of us have typed", () => {
    const mine = opened("Start");
    const manager = documentUndoManager(mine);

    const theirs = new Y.Doc();
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine));
    theirs.transact(() => paragraph(theirs).insert(5, " theirs"), LOCAL_ORIGIN);
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs), REMOTE_ORIGIN);

    type(mine, paragraph(mine).length, " mine");
    expect(paragraph(mine).toString()).toContain(" mine");

    manager.undo();
    const after = paragraph(mine).toString();
    expect(after).not.toContain(" mine");
    // Theirs survives, which is the point of tracking origins at all.
    expect(after).toContain(" theirs");
    manager.destroy();
  });

  it("treats adding a paragraph as one undoable step", () => {
    // Why the scope is the array and not one Y.Text: `+ Paragraph` has to be
    // undoable too, and a manager per textarea could not see it.
    const doc = opened("First");
    const manager = documentUndoManager(doc);

    doc.transact(() => {
      const block = new Y.Map<unknown>();
      block.set("type", "paragraph");
      block.set("text", new Y.Text());
      doc.getArray<Y.Map<unknown>>("blocks").push([block]);
    }, LOCAL_ORIGIN);

    expect(doc.getArray("blocks").length).toBe(2);
    manager.undo();
    expect(doc.getArray("blocks").length).toBe(1);
    manager.destroy();
  });

  it("has nothing to undo on a document nobody has touched", () => {
    const doc = opened();
    const manager = documentUndoManager(doc);
    expect(manager.canUndo()).toBe(false);
    expect(manager.canRedo()).toBe(false);
    manager.destroy();
  });
});

describe("a paragraph as the string an editor edits", () => {
  const paragraphOf = (text: string, people = [RILEY]) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, docStateFromText(text, people));
    return doc.getArray<Y.Map<unknown>>("blocks").get(0)!.get("text") as Y.Text;
  };

  it("spends exactly one character on a mention, so offsets stay true", () => {
    // The property everything else rests on (D-117): a string offset and a
    // Y.Text offset are the same number.
    const text = paragraphOf("Ask @Riley Kaur today");
    const serialized = blockString(text);

    expect(serialized).toBe(`Ask ${EMBED_CHAR} today`);
    expect(serialized.length).toBe(text.length);
    expect(serialized.indexOf("today")).toBe(6);
  });

  it("does not let Y.Text.toString() shorten the paragraph behind our back", () => {
    // toString() drops embeds, so every offset after a mention would be one
    // short — the silent off-by-one blockString exists to prevent.
    const text = paragraphOf("Ask @Riley Kaur today");
    expect(text.toString().length).toBe(text.length - 1);
    expect(blockString(text).length).toBe(text.length);
  });

  it("deletes a mention as one character when a range covers it", () => {
    const text = paragraphOf("Ask @Riley Kaur today");
    const { at, removed, added } = replacedRange(blockString(text), "Ask  today");

    expect({ at, removed, added }).toEqual({ at: 4, removed: 1, added: "" });

    text.delete(at, removed);
    expect(blockString(text)).toBe("Ask  today");
    expect(richTextFrom(Y.encodeStateAsUpdate(text.doc!))!.content[0]!.content).toEqual([
      { type: "text", text: "Ask  today" },
    ]);
  });

  it("reports typing after a mention at the offset the CRDT means", () => {
    const text = paragraphOf("Ask @Riley Kaur");
    const before = blockString(text);
    const { at, removed, added } = replacedRange(before, `${before} please`);

    expect(at).toBe(before.length);
    expect(removed).toBe(0);

    text.insert(at, added);
    expect(searchTextFrom(Y.encodeStateAsUpdate(text.doc!))).toBe("Ask @Riley Kaur please");
  });
});

describe("the diff a keystroke becomes", () => {
  it("sees one inserted run", () => {
    expect(replacedRange("Helo", "Hello")).toEqual({ at: 3, removed: 0, added: "l" });
  });

  it("sees one deleted run", () => {
    expect(replacedRange("Hello", "Helo")).toEqual({ at: 3, removed: 1, added: "" });
  });

  it("sees a selection replaced", () => {
    expect(replacedRange("Hello world", "Hello there")).toEqual({
      at: 6,
      removed: 5,
      added: "there",
    });
  });

  it("sees nothing when nothing changed", () => {
    expect(replacedRange("Hello", "Hello")).toEqual({ at: 5, removed: 0, added: "" });
  });

  it("does not mistake a repeated character for a longer common suffix", () => {
    // "aa" → "aaa" has three equally valid answers; any one of them is right
    // as long as it is exactly one insert of one character.
    const { removed, added } = replacedRange("aa", "aaa");
    expect({ removed, added }).toEqual({ removed: 0, added: "a" });
  });
});

describe("text as it is safe to insert", () => {
  it("drops a pasted U+FFFC, which would otherwise read back as a mention", () => {
    expect(typeable(`a${EMBED_CHAR}b`)).toBe("ab");
  });

  it("leaves ordinary text alone", () => {
    expect(typeable("plain")).toBe("plain");
  });
});

describe("an @ being typed", () => {
  it("is found from the caret back to the @", () => {
    expect(mentionQuery("Ask @ril", 8)).toEqual({ at: 4, query: "ril" });
  });

  it("starts a paragraph", () => {
    expect(mentionQuery("@ril", 4)).toEqual({ at: 0, query: "ril" });
  });

  it("keeps spaces, because names have them", () => {
    // A picker that stopped at the first space could never offer "Riley Kaur".
    expect(mentionQuery("Ask @Riley K", 12)).toEqual({ at: 4, query: "Riley K" });
  });

  it("is nothing when the @ is inside a word, so an email is not a mention", () => {
    expect(mentionQuery("riley@arbor.dev", 15)).toBeNull();
  });

  it("does not reach through a newline", () => {
    expect(mentionQuery("@Riley\nand", 10)).toBeNull();
  });

  it("does not reach through a mention that is already resolved", () => {
    expect(mentionQuery(`@${EMBED_CHAR} and`, 6)).toBeNull();
  });

  it("is nothing when the caret is before the @", () => {
    expect(mentionQuery("Ask @ril", 4)).toBeNull();
  });
});

describe("who an @ query could mean", () => {
  const people = [
    RILEY,
    { id: "user-sam", name: "Sam Petrov" },
    { id: "user-riley-two", name: "Riley Okafor" },
    { id: "user-ari", name: "Ari Riley-Jones" },
  ];

  it("matches case-insensitively, the same rule search uses", () => {
    expect(mentionMatches(people, "riley").map((p) => p.name)).toEqual([
      "Riley Kaur",
      "Riley Okafor",
      "Ari Riley-Jones",
    ]);
  });

  it("offers a name that starts with the query before one that contains it", () => {
    // Somebody typing three letters usually means the name they begin.
    expect(mentionMatches(people, "riley")[0]!.name).toBe("Riley Kaur");
  });

  it("narrows as more is typed", () => {
    expect(mentionMatches(people, "riley o").map((p) => p.name)).toEqual(["Riley Okafor"]);
  });

  it("offers everybody when nothing has been typed after the @", () => {
    expect(mentionMatches(people, "")).toHaveLength(4);
  });

  it("offers nobody when nothing matches, which is how the picker closes", () => {
    expect(mentionMatches(people, "zzz")).toEqual([]);
  });

  it("stops at the limit, because a picker is a menu and not a directory", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `u${i}`, name: `Person ${i}` }));
    expect(mentionMatches(many, "person")).toHaveLength(6);
  });
});
