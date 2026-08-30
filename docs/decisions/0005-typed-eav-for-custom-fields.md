# 5. Typed EAV for custom field values

**Status:** accepted · 2026-08-30

## Context

Custom fields are open-ended: a workspace defines any number of them, of any
type. Three storage options, and the choice determines whether filtering stays
fast at a million tasks.

| Option | Filtering | Verdict |
| --- | --- | --- |
| JSONB blob on `tasks` | GIN index; awkward for range and sort | Fastest to ship, hits a wall on sorted + filtered views |
| Typed EAV table | Indexed per column; one subquery per filtered field | **Chosen** |
| Physical column per field | Native, fastest | Runtime DDL, per-tenant schema drift. No. |

## Decision

`field_values (task_id, field_id, value_text, value_num, value_date, value_bool,
value_json)` with an index on each typed column.

Derived fields — formula, rollup, automatic progress — write their computed
result into the same row, invalidated by the activity log. Computing at read
time is what makes products in this category feel slow.

## Consequences

- Filters compile to `EXISTS` subqueries against an indexed typed column.
- Sorting by a custom field uses a correlated scalar subquery, so tasks with no
  value sort as NULL rather than dropping out of the result.
- One row per (task, field) — wider than JSONB, and worth it.
- The compiler must pick the column from the JavaScript value type. A number
  filter against a text field silently matches nothing; validate field type
  against filter value at the API boundary.
