import { describe, expect, it } from "vitest";

import {
  EMPTY_DOC,
  type RichDoc,
  isEmptyDoc,
  mentionedIds,
  parseRichText,
  parseStoredDoc,
  renderPlain,
} from "./richtext";

const people = [
  { id: "riley", name: "Riley Kaur" },
  { id: "sam", name: "Sam Petrov" },
  { id: "avery", name: "Avery Mills" },
];

describe("plain text becomes a document", () => {
  it("makes one paragraph from one line", () => {
    expect(parseRichText("Shipping today", people)).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Shipping today" }] }],
    });
  });

  it("splits paragraphs on a blank line", () => {
    const doc = parseRichText("First.\n\nSecond.", people);
    expect(doc.content).toHaveLength(2);
    expect(renderPlain(doc)).toBe("First.\n\nSecond.");
  });

  // A wrapped line is one thought, not three.
  it("joins a single newline into the same paragraph", () => {
    const doc = parseRichText("one\ntwo\nthree", people);
    expect(doc.content).toHaveLength(1);
    expect(renderPlain(doc)).toBe("one two three");
  });

  it("drops empty paragraphs rather than storing them", () => {
    expect(parseRichText("\n\n\n", people)).toEqual(EMPTY_DOC);
    expect(isEmptyDoc(parseRichText("   ", people))).toBe(true);
  });
});

describe("mentions", () => {
  it("becomes a node carrying the id", () => {
    const doc = parseRichText("Ping @Riley Kaur about it", people);
    expect(doc.content[0]!.content).toEqual([
      { type: "text", text: "Ping " },
      { type: "mention", userId: "riley", label: "Riley Kaur" },
      { type: "text", text: " about it" },
    ]);
  });

  // Names have spaces, so one word is not enough to match on.
  it("prefers the longest matching name", () => {
    const withBoth = [...people, { id: "riley-short", name: "Riley" }];
    const doc = parseRichText("@Riley Kaur", withBoth);
    expect(mentionedIds(doc)).toEqual(["riley"]);
  });

  it("still matches the short name when that is what was typed", () => {
    const withBoth = [...people, { id: "riley-short", name: "Riley" }];
    expect(mentionedIds(parseRichText("@Riley ships it", withBoth))).toEqual(["riley-short"]);
  });

  it("leaves an unknown name as text", () => {
    const doc = parseRichText("@Nobody Here", people);
    expect(mentionedIds(doc)).toEqual([]);
    expect(renderPlain(doc)).toBe("@Nobody Here");
  });

  /**
   * Picking one of two people with the same name would notify the wrong person
   * with nothing on screen saying so. Not resolving is visible; guessing is not.
   */
  it("leaves a name two people share as text", () => {
    const twins = [
      { id: "a", name: "Alex Kim" },
      { id: "b", name: "Alex Kim" },
    ];
    const doc = parseRichText("@Alex Kim", twins);
    expect(mentionedIds(doc)).toEqual([]);
    expect(renderPlain(doc)).toBe("@Alex Kim");
  });

  it("deduplicates someone mentioned twice", () => {
    expect(mentionedIds(parseRichText("@Sam Petrov and @Sam Petrov", people))).toEqual(["sam"]);
  });

  it("survives a round trip through plain text", () => {
    const original = "Ping @Riley Kaur.\n\nAlso @Sam Petrov.";
    expect(renderPlain(parseRichText(original, people))).toBe(original);
  });

  it("refuses a document longer than the cap", () => {
    expect(() => parseRichText("x".repeat(20_001), people)).toThrow();
  });
});

describe("a document read back out of the database", () => {
  it("accepts one this module wrote", () => {
    const doc = parseRichText("Ping @Avery Mills", people);
    expect(parseStoredDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  // Stored JSON was written by a client, and by an older version of this code.
  // A renderer that walks it unchecked takes a whole page down for one bad row.
  it.each([
    ["null", null],
    ["a string", "hello"],
    ["the wrong root", { type: "paragraph", content: [] }],
    ["content that is not an array", { type: "doc", content: "no" }],
    ["a block that is not a paragraph", { type: "doc", content: [{ type: "heading" }] }],
    [
      "an inline node of an unknown kind",
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "image" }] }] },
    ],
    [
      "a mention with no id",
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", label: "x" }] }] },
    ],
  ])("rejects %s", (_label, value) => {
    expect(parseStoredDoc(value)).toBeNull();
  });

  it("accepts an empty document", () => {
    const parsed: RichDoc | null = parseStoredDoc({ type: "doc", content: [] });
    expect(parsed).toEqual(EMPTY_DOC);
  });
});
