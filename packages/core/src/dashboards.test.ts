import { describe, expect, it } from "vitest";

import {
  DashboardError,
  MAX_CARDS,
  barFractions,
  chartDefinition,
  parseCard,
  parseLayout,
} from "./dashboards";
import { DEFAULT_VIEW_DEFINITION } from "./views/types";

const stat = {
  id: "c1",
  kind: "stat",
  title: "Open tasks",
  scope: { kind: "list", id: "l1" },
  definition: DEFAULT_VIEW_DEFINITION,
  aggregate: { fn: "count" },
};

const chart = {
  id: "c2",
  kind: "chart",
  title: "By status",
  scope: { kind: "list", id: "l1" },
  definition: DEFAULT_VIEW_DEFINITION,
  groupBy: "status",
};

describe("parseCard", () => {
  it("reads a stat and a chart", () => {
    expect(parseCard(stat).kind).toBe("stat");
    expect(parseCard(chart).kind).toBe("chart");
  });

  it("refuses a kind nobody declared", () => {
    // The kind decides which compiler function runs, so an unknown one is not
    // a rendering fallback — there is nothing to call.
    expect(() => parseCard({ ...stat, kind: "gauge" })).toThrow(DashboardError);
  });

  it("refuses an aggregate nobody declared", () => {
    // `layout` is client input; a function name reaching the query as text
    // would be a way to write SQL into it.
    expect(() => parseCard({ ...stat, aggregate: { fn: "drop" } })).toThrow(DashboardError);
  });

  it("refuses a total with nothing to total", () => {
    expect(() => parseCard({ ...stat, aggregate: { fn: "sum" } })).toThrow(/field/);
  });

  it("refuses a chart with no axis", () => {
    expect(() => parseCard({ ...chart, groupBy: "" })).toThrow(DashboardError);
  });

  it("refuses a card with no title, because a number with no label is a riddle", () => {
    expect(() => parseCard({ ...stat, title: "   " })).toThrow(DashboardError);
  });

  it("defaults a missing definition rather than refusing", () => {
    // "Every task in this list" is a perfectly good card, and the one somebody
    // building their first dashboard means.
    const card = parseCard({ ...stat, definition: undefined });
    expect(card.definition).toEqual(DEFAULT_VIEW_DEFINITION);
  });

  it("trims the title it stores", () => {
    expect(parseCard({ ...stat, title: "  Open  " }).title).toBe("Open");
  });
});

describe("parseLayout", () => {
  it("drops a broken card and keeps the rest, saying how many", () => {
    // One card whose spec will not parse must not take the other eleven with
    // it — a dashboard is independent pieces.
    const { cards, dropped } = parseLayout([stat, { kind: "nonsense" }, chart]);
    expect(cards.map((card) => card.id)).toEqual(["c1", "c2"]);
    expect(dropped).toBe(1);
  });

  it("treats anything that is not a list as an empty dashboard", () => {
    expect(parseLayout(null)).toEqual({ cards: [], dropped: 0 });
    expect(parseLayout({ cards: [] })).toEqual({ cards: [], dropped: 0 });
  });

  it("stops at the ceiling rather than rendering a thousand cards", () => {
    const many = Array.from({ length: MAX_CARDS + 5 }, (_, i) => ({ ...stat, id: `c${i}` }));
    expect(parseLayout(many).cards).toHaveLength(MAX_CARDS);
  });
});

describe("chartDefinition", () => {
  it("makes the card's axis win over whatever the definition stored", () => {
    // Otherwise a drifted grouping makes the chart group by something other
    // than its own axis label, silently.
    const card = parseCard({
      ...chart,
      groupBy: "priority",
      definition: { ...DEFAULT_VIEW_DEFINITION, grouping: { field: "status", dir: "asc" } },
    });
    expect(chartDefinition(card as never).grouping).toEqual({ field: "priority", dir: "asc" });
  });

  it("leaves the filters alone", () => {
    const card = parseCard(chart);
    expect(chartDefinition(card as never).filters).toEqual(DEFAULT_VIEW_DEFINITION.filters);
  });
});

describe("barFractions", () => {
  it("measures against the largest, not the total", () => {
    // Against the total, four equal groups are four stubs a quarter across.
    expect(barFractions([5, 5, 5, 5])).toEqual([1, 1, 1, 1]);
  });

  it("fills the row for the biggest and reads the rest against it", () => {
    expect(barFractions([10, 5, 0])).toEqual([1, 0.5, 0]);
  });

  it("gives zeroes for an empty chart rather than NaN", () => {
    expect(barFractions([0, 0])).toEqual([0, 0]);
    expect(barFractions([])).toEqual([]);
  });
});
