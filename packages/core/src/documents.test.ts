import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  DocumentError,
  applyDocUpdate,
  diffFor,
  docStateFrom,
  docStateFromText,
  emptyDocState,
  richTextFrom,
  searchTextFrom,
  stateVectorOf,
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
