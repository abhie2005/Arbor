# 6. A document's CRDT is the block tree, and the block tree is the projection

**Status:** accepted · 2026-09-28

## Context

ADR 4 chose a CRDT for rich text and server authority for records, and named
Yjs. It did not say what a Yjs document *contains*, and that is the part every
later decision hangs off: a CRDT is a shape as much as a synchronisation
strategy, and the shape cannot be changed afterwards without migrating every
document ever written.

Two things exist already and have to keep being true. `richtext.ts` is the
document format for comments and descriptions — a block tree whose mentions are
*nodes carrying a user id*, never the characters "@Name" (D-083, invariant 7).
And the transport question ADR 4 answered with "one WebSocket per client" has
since been answered differently: changes ride Postgres `LISTEN/NOTIFY` announced
inside the transaction that made them, and reach browsers over one `EventSource`
per client (D-090). `apps/realtime` was deleted rather than built.

## Decision

**The Yjs document is the existing block tree, expressed in Yjs types.** A
document body is a `Y.Array` of blocks; a block is a `Y.Map` with a `type` and a
`Y.Text`; a mention is an **embed** inside that text carrying `userId` and
`label`. It is the same tree `richtext.ts` describes, so the editor adopts the
format rather than replacing it.

**The projection is what everything that is not an editor reads.**
`richTextFrom` turns stored state into a `RichDoc`, and `searchTextFrom`
flattens it for `docs.search_text`. Both are computed **on write**. Nothing
outside the editing path loads a CRDT: the notification fan-out asks the
projection who was mentioned, search reads the flattened text, and a renderer
gets the block tree it already knows how to render.

**Updates travel over the transport that exists.** A client POSTs a binary
update; the server merges it into the stored state with `Y.mergeUpdates` —
without instantiating a document — and announces a nudge on the same
`pg_notify` channel every other change uses (D-090). Other viewers pull the
difference for their own state vector. This supersedes ADR 4's transport
paragraph, which predates the decision to carry everything on Postgres.

## Consequences

- One document format across comments, descriptions and docs, which is what
  makes "turn this comment into a doc" a conversion rather than a rewrite.
- A mention survives collaborative editing as a reference. Storing it as text
  would have been permanent: there is no migration over a CRDT's history.
- The server never has to sequence updates, because merging is commutative.
  Accepting an edit is a merge and a write, not a transaction that has to order
  itself against concurrent ones.
- Writes cost a projection. A keystroke that reaches the server re-derives the
  block tree and the search text for that document — cheap per document, and the
  reason updates are batched by the editor rather than sent per character.
- An editor is now bounded work: the format, the merge and the projection are
  settled, and what is left is a surface that produces updates.
- A second block kind (a heading, a list, an embed) is a `type` the projection
  learns, not a new document format. A block kind the reader does not know makes
  *that document* unreadable rather than corrupting it — the projection returns
  null and the page says so.
