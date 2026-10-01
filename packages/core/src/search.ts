/**
 * Search, as values.
 *
 * `docs.search_text` has been maintained on every write since D-111 and nothing
 * has ever read it. This module is the half of reading it that does not need a
 * database: what a typed query means, and what a result looks like once you
 * have the row.
 *
 * **Matching is substring, case-insensitive — the same rule the view compiler
 * already uses** (D-113). `parseQuery` therefore does no stemming and no
 * tokenizing into a query language; it trims, collapses whitespace and caps the
 * length. What it produces is handed to `ILIKE` as one term, so this module and
 * the compiler cannot disagree about what "matches".
 *
 * Pure, like the rest of `@arbor/core`: the snippet is computed from a string
 * the caller already loaded, not from a query that asks Postgres for one.
 */

/**
 * The longest query worth running.
 *
 * Not a safety limit — the value is a bound parameter either way (compiler rule
 * 2). It is a sanity limit: a 4KB "query" is a paste accident, and `%…%` around
 * it is a sequential scan that cannot match anything a person meant.
 */
export const MAX_QUERY = 128;

/**
 * How much of a document's text a result carries.
 *
 * A snippet is context, not the page. Two hundred characters is roughly two
 * lines at the width the results list renders, and it is bounded per row rather
 * than per response — twenty results cannot add up to a megabyte of prose.
 */
export const SNIPPET_LENGTH = 200;

/**
 * What the user typed, reduced to what will be matched.
 *
 * Returns null for a query with nothing in it, which is the signal to render
 * the empty state rather than to run a query matching every row: `ILIKE '%%'`
 * is true of every non-null value, so an empty term is not a search that finds
 * nothing — it is a search that finds *everything*, which is the more expensive
 * mistake and the one that looks like a working feature.
 */
export function parseQuery(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const term = raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY);
  return term.length === 0 ? null : term;
}

/** Where a term sits in a string, so a renderer can mark it without re-scanning. */
export interface Match {
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * Every occurrence of `term` in `text`, case-insensitively.
 *
 * Both sides are lowercased rather than compared with a locale-aware collator:
 * this has to agree with what Postgres matched, and `ILIKE` is a byte-wise
 * case fold, not a collation. A renderer that highlighted a word the query did
 * not actually match would be lying about why the row is on screen.
 *
 * Overlapping occurrences cannot happen — the scan advances past each match —
 * so the ranges are disjoint and in order, which is what lets a caller walk
 * them once to build the highlighted output.
 */
export function findMatches(text: string, term: string): Match[] {
  if (term.length === 0) return [];

  const haystack = text.toLowerCase();
  const needle = term.toLowerCase();
  const matches: Match[] = [];

  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    matches.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }

  return matches;
}

/** A window of text around a match, and where the matches are inside it. */
export interface Snippet {
  text: string;
  /** Offsets into `text`, not into the document. */
  matches: Match[];
  /** True when `text` starts mid-document, so a renderer can lead with an ellipsis. */
  truncatedStart: boolean;
  truncatedEnd: boolean;
}

/**
 * The part of a document worth showing for this query.
 *
 * **Anchored on the first match, not on the start of the text.** A handbook
 * page whose match is in the last paragraph would otherwise show its first two
 * lines, which is a result that gives no reason for being a result. The window
 * is centred on the match and then clamped to the text, so a match near either
 * end still fills the available length rather than showing half a snippet.
 *
 * Edges are moved outward to the nearest whitespace so the window does not open
 * or close inside a word — but only within a short reach, because a document
 * with no spaces for 200 characters is base64 or a URL, and hunting further for
 * a boundary there would return the whole line.
 *
 * With no match at all — the title matched and the body did not — this returns
 * the opening of the text, which is the right thing for a row that is on screen
 * for a reason the snippet cannot show.
 */
export function snippet(
  text: string,
  term: string,
  length: number = SNIPPET_LENGTH,
): Snippet {
  // Newlines collapse: `search_text` is a projection of a block tree and
  // carries the blank line between every paragraph (`searchTextFrom`), which in
  // a one-line result is spent vertical space rather than structure.
  const flat = text.replace(/\s+/g, " ").trim();

  if (flat.length <= length) {
    return {
      text: flat,
      matches: findMatches(flat, term),
      truncatedStart: false,
      truncatedEnd: false,
    };
  }

  const first = findMatches(flat, term)[0];

  let start = 0;
  if (first) {
    // Centre the match, then clamp. Clamping after centring is what keeps a
    // match in the last line from producing a window that runs off the end.
    //
    // The lead is floored at zero for a match longer than the window: without
    // it the offset goes negative and the window opens *inside* the match,
    // which cannot happen at the default length (MAX_QUERY is shorter than
    // SNIPPET_LENGTH) and does as soon as a caller passes a smaller one.
    const lead = Math.max(0, Math.floor((length - (first.end - first.start)) / 2));
    start = Math.max(0, Math.min(first.start - lead, flat.length - length));
  }
  let end = Math.min(flat.length, start + length);

  const REACH = 16;
  if (start > 0) {
    const space = flat.lastIndexOf(" ", start);
    if (space !== -1 && start - space <= REACH) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.indexOf(" ", end);
    if (space !== -1 && space - end <= REACH) end = space;
  }

  const window = flat.slice(start, end);

  return {
    text: window,
    // Re-scanned inside the window rather than offset from the full-text
    // matches: a match straddling the edge is not in this window, and
    // subtracting `start` from its offsets would point past the end of the
    // string a renderer is about to slice.
    matches: findMatches(window, term),
    truncatedStart: start > 0,
    truncatedEnd: end < flat.length,
  };
}

/**
 * `text` split into alternating plain and matched runs, for rendering.
 *
 * A renderer that did this itself would be the second place that decides what
 * counts as a match. It returns runs rather than HTML because the caller is
 * JSX: a string of `<mark>` tags would have to be trusted, and nothing in this
 * app hands the browser markup it assembled from a document's contents.
 */
export function highlight(text: string, matches: readonly Match[]): { text: string; hit: boolean }[] {
  const runs: { text: string; hit: boolean }[] = [];
  let at = 0;

  for (const match of matches) {
    if (match.start > at) runs.push({ text: text.slice(at, match.start), hit: false });
    runs.push({ text: text.slice(match.start, match.end), hit: true });
    at = match.end;
  }

  if (at < text.length) runs.push({ text: text.slice(at), hit: false });
  return runs;
}
