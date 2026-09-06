/**
 * Filters in the URL.
 *
 * A filtered view is a thing people send each other — "here's everything
 * overdue and unassigned" — so the filter has to live somewhere with an
 * address. The alternative, component state, makes the most useful views
 * unshareable and loses them on reload.
 *
 * The encoding is a compact tuple form rather than the full `FilterCondition`
 * shape, because the URL is read by humans in a Slack message and
 * `?f=[["dueAt","lt","2026-09-01"]]` survives that better than forty characters
 * of repeated key names.
 *
 * **Decoding is untrusted-input handling.** Anyone can edit a URL. This
 * validates structure only — that it is an array of triples with a known
 * operator — and leaves every semantic question (does this field exist, is this
 * operator legal for it, does the value match its type) to the compiler, which
 * already answers all three and is the boundary that matters (D-042).
 */

import type { FilterCondition, FilterGroup, FilterOp, SortField } from "./types";

export class FilterUrlError extends Error {}

const OPS: readonly FilterOp[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "nin",
  "contains",
  "notContains",
  "isNull",
  "isNotNull",
  "between",
];

/** Hard ceiling, mirroring the compiler's — a 40-filter URL is an attack, not a view. */
const MAX_CONDITIONS = 25;

type Triple = [string, string] | [string, string, unknown];

export interface UrlFilterState {
  filters: FilterGroup;
  /** Present only when it differs from the view's own default. */
  search?: string;
}

/**
 * Serializes to the shortest string that round-trips.
 *
 * Returns null when there is nothing worth putting in the URL, so callers can
 * omit the parameter entirely rather than writing `?f=[]` on every navigation.
 */
export function encodeFilters(filters: FilterGroup): string | null {
  const triples: Triple[] = filters.conditions.map((condition) =>
    condition.value === undefined
      ? [condition.field, condition.op]
      : [condition.field, condition.op, condition.value],
  );

  const parts: string[] = [];
  if (triples.length > 0) parts.push(JSON.stringify(triples));

  if (parts.length === 0 && filters.op !== "OR" && !filters.showClosed) return null;

  // The operator and showClosed ride along only when they are not the default,
  // so an ordinary filtered link stays short.
  const state: Record<string, unknown> = {};
  if (triples.length > 0) state.c = triples;
  if (filters.op === "OR") state.op = "OR";
  if (filters.showClosed) state.closed = true;

  return Object.keys(state).length > 0 ? JSON.stringify(state) : null;
}

export function decodeFilters(raw: string | null | undefined, base: FilterGroup): FilterGroup {
  if (!raw) return base;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FilterUrlError("The filter in this link is not valid JSON");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FilterUrlError("The filter in this link is not an object");
  }

  const state = parsed as { c?: unknown; op?: unknown; closed?: unknown };
  const conditions = decodeConditions(state.c);

  if (state.op !== undefined && state.op !== "AND" && state.op !== "OR") {
    throw new FilterUrlError(`Unknown filter combinator: ${String(state.op)}`);
  }

  return {
    ...base,
    op: state.op === "OR" ? "OR" : "AND",
    conditions,
    showClosed: state.closed === true ? true : base.showClosed,
  };
}

function decodeConditions(raw: unknown): FilterCondition[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new FilterUrlError("Filter conditions must be an array");

  if (raw.length > MAX_CONDITIONS) {
    throw new FilterUrlError(`A view may have at most ${MAX_CONDITIONS} filters`);
  }

  return raw.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length < 2 || entry.length > 3) {
      throw new FilterUrlError(`Filter ${index + 1} is not a [field, operator, value] triple`);
    }

    const [field, op, value] = entry as [unknown, unknown, unknown];

    if (typeof field !== "string" || field === "") {
      throw new FilterUrlError(`Filter ${index + 1} names no field`);
    }
    if (typeof op !== "string" || !OPS.includes(op as FilterOp)) {
      throw new FilterUrlError(`Filter ${index + 1} uses an unknown operator: ${String(op)}`);
    }

    // The field string is not checked against the known set here — the compiler
    // resolves it through a closed map and rejects anything else (D-018), and
    // duplicating that list would give it two places to drift.
    return entry.length === 2
      ? ({ field, op } as FilterCondition)
      : ({ field, op, value } as FilterCondition);
  });
}

/**
 * Sort in the URL, for the same reason filters are (D-055).
 *
 * Clicking a column header is exploration, not a decision about the saved
 * view: "who is going to miss the deadline" is a table sorted by due date and
 * a link worth pasting into a channel, and it should neither be lost on reload
 * nor change the view for everyone who opens it.
 *
 * `?s=[["dueAt","desc"]]` — the same compact tuple shape the filter encoding
 * uses, and validated the same way: structure here, meaning in the compiler.
 * A field name is not checked against the known set, because `orderExpr`
 * resolves it through a closed map and rejects anything else (D-018).
 */
export function encodeSort(sort: readonly SortField[]): string | null {
  if (sort.length === 0) return null;
  return JSON.stringify(sort.map((field) => [field.field, field.dir]));
}

export function decodeSort(raw: string | null | undefined, base: SortField[]): SortField[] {
  if (!raw) return base;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FilterUrlError("The sort in this link is not valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new FilterUrlError("The sort in this link is not an array");
  }

  // MAX_SORTS in the compiler is 5; a longer list is a malformed link rather
  // than a view, and silently truncating it would sort by something the URL
  // does not say.
  if (parsed.length > 5) {
    throw new FilterUrlError("A view may sort by at most 5 fields");
  }

  return parsed.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new FilterUrlError(`Sort ${index + 1} is not a [field, direction] pair`);
    }

    const [field, dir] = entry as [unknown, unknown];

    if (typeof field !== "string" || field === "") {
      throw new FilterUrlError(`Sort ${index + 1} names no field`);
    }
    if (dir !== "asc" && dir !== "desc") {
      throw new FilterUrlError(`Sort ${index + 1} has an unknown direction: ${String(dir)}`);
    }

    return { field, dir } as SortField;
  });
}
