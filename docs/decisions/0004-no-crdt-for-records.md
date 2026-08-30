# 4. CRDTs for documents, server-authority for records

**Status:** accepted · 2026-08-30

## Context

The product has two kinds of collaborative data, and the common mistake is
picking one synchronization strategy for both.

## Decision

**Structured records** (tasks, fields, statuses) are server-authoritative. The
client writes optimistically to a local cache; the server validates and
broadcasts a delta. Conflicts are per-field and rare, and last-write-wins is
acceptable.

**Rich text and canvas** (docs, whiteboards, task descriptions) use a CRDT — Yjs
— with a persistence layer and cursor awareness.

Transport is shared: one WebSocket per client multiplexing record deltas,
document updates, and presence. Fan-out is permission-filtered server-side.

## Consequences

- Server-side validation stays possible for records. A CRDT would have made
  "you may not set this status" unenforceable.
- Enormous complexity avoided for a conflict rate near zero on records.
- Two sync paths to maintain, and the boundary must stay clear: if a field
  becomes collaboratively edited, it moves to the CRDT side.
