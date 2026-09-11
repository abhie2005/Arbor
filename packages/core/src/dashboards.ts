import { AGGREGATE_FNS, type AggregateSpec } from "./views/compile";
import { DEFAULT_VIEW_DEFINITION, type FieldRef, type ViewDefinition, type ViewScope } from "./views/types";

/**
 * Dashboards, as rules.
 *
 * **A card's kind is which compiler call it makes**, and that is the whole of
 * the design (D-104). `dashboards.layout` is described by its own column
 * comment as "a grid of cards; each card is a saved query plus a chart spec",
 * which leaves open the question that had to be answered before the first card:
 * does a card compile to *rows* or to *one number*? Those are two different
 * functions with two different shapes coming back, and a card that could be
 * either is a card whose renderer has to ask at run time.
 *
 * So it is settled in the type. A `stat` is `compileAggregate` — one number. A
 * `chart` is `compileGroupCounts` — one number per group. Each kind names
 * exactly one entry point, the resolver switches once, and adding a third kind
 * means adding a third entry point rather than teaching one of these two to
 * return something else.
 *
 * Every card carries a view definition for the same reason a key result does
 * (D-101): "which tasks" is a question the compiler already answers, and a
 * second way of asking it is a second set of answers.
 */

export const CARD_KINDS = ["stat", "chart"] as const;

export type CardKind = (typeof CARD_KINDS)[number];

export class DashboardError extends Error {}

/** What every card has, whatever it draws. */
interface CardBase {
  id: string;
  title: string;
  scope: ViewScope;
  definition: ViewDefinition;
}

/** One number. `compileAggregate`. */
export interface StatCard extends CardBase {
  kind: "stat";
  aggregate: AggregateSpec;
  /** Rendered after the number — "tasks", "points", "h". Cosmetic. */
  unit?: string;
}

/**
 * One number per group. `compileGroupCounts`.
 *
 * `groupBy` is a `FieldRef` rather than a free string because the compiler's
 * own grouping is, and putting it on the card means the definition's `grouping`
 * is what actually drives the query — this field is copied onto it when the
 * card is resolved, so the two cannot disagree.
 */
export interface ChartCard extends CardBase {
  kind: "chart";
  groupBy: FieldRef;
}

export type DashboardCard = StatCard | ChartCard;

/** What the column holds: an ordered list. Position is the array index. */
export type DashboardLayout = DashboardCard[];

/** A dashboard may hold this many cards. */
export const MAX_CARDS = 24;

export function isCardKind(value: unknown): value is CardKind {
  return typeof value === "string" && (CARD_KINDS as readonly string[]).includes(value);
}

/**
 * Reads a stored layout, refusing one that does not describe what it claims.
 *
 * **Returns a value rather than throwing on a bad card.** A dashboard is a
 * screen made of independent pieces, and one card whose spec will not parse
 * must not take the other eleven with it — the same reason a comment whose
 * stored JSON does not parse renders as unreadable while the thread renders
 * normally. The card is dropped and the count of what was dropped is returned,
 * so the screen can say so rather than quietly showing eleven of twelve.
 */
export function parseLayout(raw: unknown): { cards: DashboardLayout; dropped: number } {
  if (!Array.isArray(raw)) return { cards: [], dropped: 0 };

  const cards: DashboardLayout = [];
  let dropped = 0;

  for (const entry of raw.slice(0, MAX_CARDS)) {
    try {
      cards.push(parseCard(entry));
    } catch {
      dropped += 1;
    }
  }

  return { cards, dropped };
}

/**
 * One card, validated.
 *
 * Throws, unlike `parseLayout`: this is what the write path calls, and the
 * write path is the end where a broken card is still someone's mistake to fix
 * (the rule `validateColumns` already follows, D-060).
 */
export function parseCard(raw: unknown): DashboardCard {
  if (typeof raw !== "object" || raw === null) {
    throw new DashboardError("A card has to be an object");
  }

  const card = raw as Record<string, unknown>;

  if (!isCardKind(card.kind)) {
    throw new DashboardError(`"${String(card.kind)}" is not a kind of card`);
  }
  if (typeof card.id !== "string" || card.id === "") {
    throw new DashboardError("A card needs an id");
  }
  if (typeof card.title !== "string" || card.title.trim() === "") {
    throw new DashboardError("A card needs a title");
  }
  if (typeof card.scope !== "object" || card.scope === null) {
    throw new DashboardError("A card needs a scope");
  }

  const base: CardBase = {
    id: card.id,
    title: card.title.trim(),
    scope: card.scope as ViewScope,
    // A missing definition is the default one rather than a refusal: "every
    // task in this list" is a perfectly good card, and it is the one somebody
    // building their first dashboard means.
    definition: (card.definition as ViewDefinition | undefined) ?? DEFAULT_VIEW_DEFINITION,
  };

  if (card.kind === "stat") {
    const aggregate = card.aggregate as AggregateSpec | undefined;
    if (!aggregate || !AGGREGATE_FNS.includes(aggregate.fn)) {
      throw new DashboardError("A stat card needs to say what it counts");
    }
    if (aggregate.fn !== "count" && !aggregate.field) {
      throw new DashboardError(`A "${aggregate.fn}" card needs a field to total`);
    }
    return {
      ...base,
      kind: "stat",
      aggregate,
      unit: typeof card.unit === "string" ? card.unit : undefined,
    };
  }

  if (typeof card.groupBy !== "string" || card.groupBy === "") {
    throw new DashboardError("A chart card needs something to group by");
  }

  return { ...base, kind: "chart", groupBy: card.groupBy as FieldRef };
}

/**
 * The definition a chart actually runs.
 *
 * The card names its `groupBy` and the compiler reads `definition.grouping`, so
 * one of them has to win. This is where the card's wins — every time, rather
 * than at whichever call site remembered — because a stored definition whose
 * grouping drifted from the card's would make the chart silently group by
 * something other than its own axis label.
 */
export function chartDefinition(card: ChartCard): ViewDefinition {
  return {
    ...card.definition,
    grouping: { field: card.groupBy, dir: "asc" },
  };
}

/**
 * Bar lengths for a chart, as fractions of its largest slice.
 *
 * **Of the largest, not of the total.** A share-of-total bar is a pie chart
 * drawn straight, and it makes the common case — four groups of roughly equal
 * size — four stubs a quarter of the way across. Against the largest, the
 * biggest group fills the row and the rest are read against it, which is the
 * comparison a bar chart is for.
 *
 * An all-zero chart gets zeroes rather than `NaN`, which is what dividing by
 * the largest would otherwise produce on an empty list.
 */
export function barFractions(counts: readonly number[]): number[] {
  const largest = Math.max(0, ...counts);
  if (largest === 0) return counts.map(() => 0);
  return counts.map((count) => count / largest);
}
