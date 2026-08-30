# 2. Fractional indices for ordering

**Status:** accepted · 2026-08-30

## Context

Everything in the product is drag-reorderable: tasks in a list, lists in a
folder, board columns, checklist items, view tabs.

With integer positions, dropping a task at the top of a 500-row list rewrites 500
rows — and in a real-time product, each of those is a broadcast to every
connected client. Two people dragging at once produce a renumbering race.

## Decision

Positions are **fractional index strings** that sort lexicographically. A move
writes exactly one row. Generation is delegated to the `fractional-indexing`
package rather than hand-rolled — the midpoint algorithm with integer-part
carry is subtle, and a bug in it corrupts ordering silently.

`packages/core/src/ordering.ts` is the domain-shaped wrapper: `positionBetween`,
`positionForMove`, `initialPositions`, `needsRebalance`.

## Consequences

- One row written per drag, one delta broadcast.
- Concurrent drags converge instead of fighting.
- Strings grow under repeated insertion at the same point. Bounded in practice;
  `needsRebalance()` flags a collection for a background rewrite past 48 chars.
- Positions are opaque. Never expose them in the API as sort keys.
