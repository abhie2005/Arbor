# 1. One polymorphic container tree

**Status:** accepted · 2026-08-30

## Context

Space, Folder, and List are presented to users as three different things, and the
obvious schema is three tables. The incumbent products in this category started
that way, and every one of them later had to bolt on an extra nesting level
("subfolders") as a schema migration.

Two facts break the three-table model:

- A list can sit **directly inside a space**, with no folder. Three tables means
  a nullable folder id plus a second code path for every query.
- Teams want **more nesting**, and each additional level is another table.

## Decision

One `containers` table with a self-referencing `parent_id` and a `kind`
discriminator. Depth is unconstrained.

## Consequences

- Subfolders are free — they are just a folder whose parent is a folder.
- Every tree operation (move, archive, permission inheritance, breadcrumb) is
  written once.
- Recursive queries need care. Mitigated by denormalizing `space_id` and
  `folder_id` onto tasks (ADR 3), so the hot path never recurses.
- `kind` must be validated in the service layer: a list cannot contain a folder.
