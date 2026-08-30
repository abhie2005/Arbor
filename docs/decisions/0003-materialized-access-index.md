# 3. Materialize permissions instead of walking the tree

**Status:** accepted · 2026-08-30

## Context

Any container can be private, access inherits downward, and it can be tightened
at any level. Answering "can this user see this task" by walking parents costs
one join per level of nesting — on **every view query**, for every viewer.

## Decision

`grants` stays the source of truth and is cheap to write. A background job
flattens grants plus inheritance into `access_index (principal_id, list_id,
permission)` whenever a grant changes or a container moves.

Every task query begins with:

```sql
JOIN access_index ax ON ax.list_id = t.home_list_id AND ax.principal_id = $viewer
```

It is the first join because it is the most selective predicate in the query.

## Consequences

- Permission filtering is part of the query plan, not a post-processing pass —
  which is also what makes it impossible to leak a private list by forgetting a
  check.
- The "Everything" view becomes trivial: no scope predicate at all, because the
  access index already defines what "everything" means for that viewer.
- The index is eventually consistent. A revoked grant is visible for as long as
  the rebuild takes; revocations that must be immediate need a direct delete.
- Group grants are expanded into per-user rows during the rebuild.
