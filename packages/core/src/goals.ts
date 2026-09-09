import { AGGREGATE_FNS, type AggregateSpec } from "./views/compile";
import type { ViewDefinition, ViewScope } from "./views/types";

/**
 * Goals and key results, as rules.
 *
 * A goal is a name and a due date; the meaning is entirely in its key results,
 * and a key result is four text columns whose meaning depends on one more. That
 * shape is `field_values` again — a row that stores everything as text and a
 * `kind` that says how to read it — so it is declared the same way the 20 field
 * types are (`fields.ts`): one table, in one place, saying how to parse a value,
 * how to render it, and how to turn it into progress.
 *
 * The alternative is a switch on `kind` in every consumer, which is how the
 * screen and the roll-up start disagreeing about what "60%" meant.
 *
 * Pure. Rollups need a database and are resolved in `@arbor/db`; what lives
 * here is the arithmetic and the validation, because both are small, easy to
 * get subtly wrong, and invisible when they are.
 */

/**
 * What a key result measures.
 *
 * The four the schema's own comment names. `rollup` is the one that is derived
 * rather than entered, and the only one whose `source` describes a query.
 */
export const KEY_RESULT_KINDS = ["number", "currency", "boolean", "rollup"] as const;

export type KeyResultKind = (typeof KEY_RESULT_KINDS)[number];

export class GoalError extends Error {}

export function isKeyResultKind(value: unknown): value is KeyResultKind {
  return typeof value === "string" && (KEY_RESULT_KINDS as readonly string[]).includes(value);
}

/**
 * What a rollup counts.
 *
 * A view definition and an aggregate — deliberately, and this is the decision
 * the whole feature turned on. `source` could have held a small query language
 * of its own, and the view compiler already *is* one (D-032): scope, nested
 * filters, custom fields, permission scoping, all validated. A second one would
 * have been a second set of answers to "does this task count", and the day they
 * disagreed would have been a day nobody could explain.
 */
export interface RollupSource {
  scope: ViewScope;
  definition: ViewDefinition;
  aggregate: AggregateSpec;
}

/** A currency key result carries its code here; it has nowhere else to live. */
export interface CurrencySource {
  currency: string;
}

/**
 * One key result, as the rest of the system sees it.
 *
 * `current` is null for a rollup that has not been resolved yet — the column is
 * genuinely empty for those, because nothing writes it (see `resolveRollups`).
 */
export interface KeyResult {
  id: string;
  name: string;
  kind: KeyResultKind;
  start: number;
  target: number;
  current: number | null;
  source: Record<string, unknown>;
  position: string;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Reads one of the three text columns.
 *
 * `boolean` accepts what a checkbox posts as well as what the column holds,
 * because the same parser sits behind a form and behind a row read back.
 */
export function parseKeyResultValue(kind: KeyResultKind, raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;

  if (kind === "boolean") {
    if (raw === true || raw === "true" || raw === "1" || raw === 1) return 1;
    if (raw === false || raw === "false" || raw === "0" || raw === 0) return 0;
    throw new GoalError("A yes/no key result is either done or not");
  }

  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value)) throw new GoalError(`"${String(raw)}" is not a number`);
  return value;
}

/** How a value is written back to its text column. */
export function serializeKeyResultValue(kind: KeyResultKind, value: number | null): string | null {
  if (value === null) return null;
  if (kind === "boolean") return value >= 1 ? "true" : "false";
  return String(value);
}

/**
 * Progress on one key result, as a fraction — or null when there is no answer.
 *
 * **Not clamped, and it handles going down.** "Reduce open bugs from 50 to 10"
 * is a key result, and it falls out of `(current - start) / (target - start)`
 * without a special case: both halves change sign together. Clamping is the
 * renderer's job, because passing a target is the most interesting thing a
 * number here can do and a function that returned 1.0 for both "just made it"
 * and "doubled it" would throw that away.
 *
 * Null when start and target are the same, because that key result asks for no
 * movement and every answer to "how far along" is equally true.
 */
export function keyResultProgress(kr: {
  kind: KeyResultKind;
  start: number;
  target: number;
  current: number | null;
}): number | null {
  if (kr.current === null) return null;
  if (kr.kind === "boolean") return kr.current >= 1 ? 1 : 0;
  if (kr.target === kr.start) return null;
  return (kr.current - kr.start) / (kr.target - kr.start);
}

/**
 * A goal's own progress: the mean of its key results.
 *
 * **Unweighted, and each one clamped before it is averaged.** Unweighted
 * because a weight is a number somebody has to justify, and the honest default
 * is that a goal's key results are the things that matter equally — if one
 * matters more, that is a second goal. Clamped because a key result at 300%
 * would otherwise carry two others that have not started, and a goal that
 * reports 100% while two thirds of it is untouched is worse than no number.
 *
 * Null when nothing can be measured — a goal with no key results is a title,
 * and a bar for it would be a made-up number.
 */
export function goalProgress(keyResults: readonly Parameters<typeof keyResultProgress>[0][]): number | null {
  const measured = keyResults
    .map((kr) => keyResultProgress(kr))
    .filter((value): value is number => value !== null)
    .map((value) => Math.max(0, Math.min(1, value)));

  if (measured.length === 0) return null;
  return measured.reduce((total, value) => total + value, 0) / measured.length;
}

/**
 * Reads a `source` blob, refusing one that does not describe what it claims.
 *
 * Validated here and compiled on write (`@arbor/db`), so a key result that
 * cannot be resolved is refused at the moment somebody writes it rather than
 * the moment somebody opens the goals screen — the same rule saved views
 * already follow.
 */
export function parseRollupSource(raw: unknown): RollupSource {
  if (typeof raw !== "object" || raw === null) {
    throw new GoalError("A rollup key result needs something to count");
  }

  const source = raw as Record<string, unknown>;
  const aggregate = source.aggregate as AggregateSpec | undefined;

  if (!aggregate || !AGGREGATE_FNS.includes(aggregate.fn)) {
    throw new GoalError("A rollup needs to say what it counts");
  }
  if (aggregate.fn !== "count" && !aggregate.field) {
    throw new GoalError(`A "${aggregate.fn}" rollup needs a field to total`);
  }
  if (typeof source.definition !== "object" || source.definition === null) {
    throw new GoalError("A rollup needs a filter to count against");
  }
  if (typeof source.scope !== "object" || source.scope === null) {
    throw new GoalError("A rollup needs a scope");
  }

  return {
    scope: source.scope as ViewScope,
    definition: source.definition as ViewDefinition,
    aggregate,
  };
}

/** The currency code on a `currency` key result. Three letters or nothing. */
export function parseCurrency(raw: unknown): string {
  const source = (raw ?? {}) as Record<string, unknown>;
  const code = typeof source.currency === "string" ? source.currency.toUpperCase() : "USD";
  if (!CURRENCY_RE.test(code)) throw new GoalError(`"${code}" is not a currency code`);
  return code;
}

/**
 * A key result's numbers, in words.
 *
 * Formatting lives beside parsing for the reason the field types do: a screen
 * that formats a currency itself is a screen that will format it differently
 * from the next one.
 */
export function formatKeyResultValue(
  kind: KeyResultKind,
  value: number | null,
  source: Record<string, unknown> = {},
): string {
  if (value === null) return "—";
  if (kind === "boolean") return value >= 1 ? "Done" : "Not done";

  if (kind === "currency") {
    try {
      return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: parseCurrency(source),
        maximumFractionDigits: 0,
      }).format(value);
    } catch {
      // An unknown code must not take the screen down with it.
      return String(round(value));
    }
  }

  return String(round(value));
}

/** Whole numbers stay whole; anything else gets one decimal and no more. */
function round(value: number): number {
  return Number.isInteger(value) ? value : Math.round(value * 10) / 10;
}
