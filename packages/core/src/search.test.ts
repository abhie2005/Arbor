import { describe, expect, it } from "vitest";

import {
  MAX_QUERY,
  findMatches,
  highlight,
  parseQuery,
  snippet,
} from "./search";

describe("parseQuery", () => {
  it("returns null for a query that would match every row", () => {
    // The point of the null: `ILIKE '%%'` is true of every non-null value, so
    // an empty term is not an empty result — it is the whole workspace.
    expect(parseQuery("")).toBeNull();
    expect(parseQuery("   ")).toBeNull();
    expect(parseQuery("\n\t ")).toBeNull();
    expect(parseQuery(null)).toBeNull();
    expect(parseQuery(undefined)).toBeNull();
  });

  it("collapses whitespace so two spaces are not a different search", () => {
    expect(parseQuery("  hiring   plan ")).toBe("hiring plan");
  });

  it("caps the length", () => {
    const parsed = parseQuery("x".repeat(MAX_QUERY + 50));
    expect(parsed).toHaveLength(MAX_QUERY);
  });

  it("keeps the characters ILIKE treats as wildcards", () => {
    // Escaping is the compiler's job (`escapeLike`), and doing it here too
    // would double it — the term has to arrive as the user typed it.
    expect(parseQuery("100%_done")).toBe("100%_done");
  });
});

describe("findMatches", () => {
  it("finds every occurrence, case-insensitively", () => {
    expect(findMatches("Design the design system", "design")).toEqual([
      { start: 0, end: 6 },
      { start: 11, end: 17 },
    ]);
  });

  it("returns ranges that are disjoint and in order", () => {
    // "aa" in "aaaa" is two matches, not three: the scan advances past each
    // one, so a renderer can walk them without checking for overlap.
    expect(findMatches("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("finds nothing in an empty term rather than everything", () => {
    expect(findMatches("anything", "")).toEqual([]);
  });
});

describe("snippet", () => {
  const long = (filler: string, match: string, tail: string) => `${filler} ${match} ${tail}`;

  it("returns short text whole, with no ellipsis either side", () => {
    const result = snippet("Ask Riley about the hiring plan", "hiring");
    expect(result.text).toBe("Ask Riley about the hiring plan");
    expect(result.truncatedStart).toBe(false);
    expect(result.truncatedEnd).toBe(false);
    expect(result.matches).toEqual([{ start: 20, end: 26 }]);
  });

  it("collapses the blank lines a block-tree projection carries", () => {
    // `searchTextFrom` joins paragraphs with "\n\n"; a one-line result should
    // not spend two blank lines on that.
    expect(snippet("Hiring plan\n\nAsk Riley", "riley").text).toBe("Hiring plan Ask Riley");
  });

  it("anchors on the match rather than on the start of the document", () => {
    const text = long("lorem ".repeat(80), "tsvector", "and the rest of it");
    const result = snippet(text, "tsvector", 60);

    expect(result.text).toContain("tsvector");
    expect(result.truncatedStart).toBe(true);
    // The whole reason the window moves: the opening of this document says
    // nothing about why it is a result. Compared against the opening rather
    // than against a prefix — the window is *centred* on the match, so the
    // words leading up to it are filler too, and that is not the bug.
    expect(result.text).not.toBe(text.replace(/\s+/g, " ").trim().slice(0, 60));
    // Centred, so the match is not jammed against either edge.
    expect(result.matches[0]!.start).toBeGreaterThan(10);
  });

  it("fills the window for a match at the very end", () => {
    const text = `${"lorem ".repeat(80)}tsvector`;
    const result = snippet(text, "tsvector", 60);

    expect(result.text).toContain("tsvector");
    expect(result.truncatedEnd).toBe(false);
    // Clamped, not centred-and-overrunning: a match in the last line still
    // gets a full window rather than half of one.
    expect(result.text.length).toBeGreaterThanOrEqual(55);
  });

  it("does not open or close inside a word", () => {
    const text = `${"alpha bravo ".repeat(20)}charlie delta echo`;
    const result = snippet(text, "charlie", 40);

    expect(result.text.startsWith(" ")).toBe(false);
    expect(result.text).toMatch(/^\S/);
    // Reached outward to a space, so the first token is whole.
    expect(["alpha", "bravo", "charlie"]).toContain(result.text.split(" ")[0]);
  });

  it("gives up on a word boundary rather than returning the whole line", () => {
    // No spaces anywhere: a URL or base64. Hunting further for a boundary
    // would defeat the length cap.
    const text = "x".repeat(400);
    const result = snippet(text, "x", 100);
    expect(result.text).toHaveLength(100);
  });

  it("keeps the window at the match when the term is longer than the window", () => {
    // The lead would go negative without the floor, opening the window inside
    // the match. Unreachable at the default length; reachable the moment a
    // caller passes a smaller one.
    const text = `${"lorem ".repeat(40)}averyveryverylongsearchterm${" ipsum".repeat(40)}`;
    const result = snippet(text, "averyveryverylongsearchterm", 10);

    expect(result.text.length).toBeGreaterThan(0);
    expect(result.matches.every((match) => match.start >= 0)).toBe(true);
    for (const match of result.matches) {
      expect(match.end).toBeLessThanOrEqual(result.text.length);
    }
  });

  it("shows the opening when only the title matched", () => {
    const text = `${"lorem ipsum ".repeat(60)}`;
    const result = snippet(text, "nowhere", 50);

    expect(result.text.startsWith("lorem ipsum")).toBe(true);
    expect(result.matches).toEqual([]);
    expect(result.truncatedStart).toBe(false);
    expect(result.truncatedEnd).toBe(true);
  });

  it("reports matches as offsets into the snippet, not into the document", () => {
    const text = long("lorem ".repeat(80), "tsvector", "and the rest of it");
    const result = snippet(text, "tsvector", 60);

    for (const match of result.matches) {
      expect(result.text.slice(match.start, match.end).toLowerCase()).toBe("tsvector");
    }
  });
});

describe("highlight", () => {
  it("splits into alternating runs", () => {
    const text = "Design the design system";
    expect(highlight(text, findMatches(text, "design"))).toEqual([
      { text: "Design", hit: true },
      { text: " the ", hit: false },
      { text: "design", hit: true },
      { text: " system", hit: false },
    ]);
  });

  it("round-trips the text exactly", () => {
    // Nothing may be dropped or duplicated: the runs are what gets rendered.
    const text = "aaaa bbbb aaaa";
    const runs = highlight(text, findMatches(text, "aaaa"));
    expect(runs.map((run) => run.text).join("")).toBe(text);
  });

  it("is one plain run when nothing matched", () => {
    expect(highlight("nothing here", [])).toEqual([{ text: "nothing here", hit: false }]);
  });

  it("is one matched run when the whole string matched", () => {
    expect(highlight("all", findMatches("all", "all"))).toEqual([{ text: "all", hit: true }]);
  });
});
