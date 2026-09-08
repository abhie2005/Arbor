# Arbor — working notes for Claude

A dense, keyboard-driven work platform. Hierarchies, saved views, custom fields,
collaboration. AGPL-3.0, self-hostable, npm workspaces + Turborepo.

**It is not a ClickUp clone** (D-001). The architecture was researched, the
product built from the patterns. Do not describe it as a clone.

## Read this first, not the whole repo

This file is the map. **Do not explore the tree to orient yourself** — go
straight to the file you need below. `docs/STATUS.md` is current state and what
is next; read it when resuming work, not to learn how things fit together.

## Commands

```bash
colima start && docker start arbor-pg     # Postgres. Colima is manual on this Mac.
cd apps/web && npx next dev -p 3100       # NOT 3000 — another project owns it

npm test                                  # unit, no database
npm run db:seed && npm run db:smoke       # against real Postgres
PORT=3100 npm run check:actions           # POSTs what a click posts; needs the dev server
npm run typecheck
```

`db:generate` then `db:migrate` for schema changes; rename the generated
migration to something descriptive and update `migrations/meta/_journal.json`.

## Invariants — breaking these silently is the main risk

1. **`applyOperations` is the only thing that writes.** Every mutation is an
   `Operation` (`packages/core/src/mutations.ts`), so the activity log and undo
   come free. A service with its own INSERT is the second writer, and the second
   writer is the one that forgets to log (D-083).
2. **No renderer has a query of its own.** Every view reads through
   `compileViewQuery`. A renderer needing something the compiler cannot say
   means the compiler grows (D-078), not that the renderer writes SQL (D-032).
3. **Every server action authorizes, not just authenticates.** `requireUser`
   says who; `requireTaskAccess` / `requireListAccess` / `requireViewAccess` /
   `requireWorkspaceRole` say whether (D-080, D-081).
4. **Reads are permission-scoped by joining `access_index`.** Grants are truth;
   the index is what queries join (ADR 3). The detail page does this by hand
   because it does not go through the compiler.
5. **Refusals never leak existence.** Unreachable reads as "no longer exists",
   in the same words as genuinely missing. Insufficient permission says so.
6. **One document format** for comments and descriptions — a block tree with
   mention *nodes* carrying user ids, `packages/core/src/richtext.ts`. Never
   store a mention as the characters "@Name" (D-083).
7. **Notifications: direct signals only.** Assigned, mentioned, replied write a
   row inside the causing transaction. Everything ambient is aggregated at read
   time from `activity` (`loadAmbient`) — fanning out to watchers is the
   200-rows-per-edit mistake the table is shaped to avoid, and so is giving a
   watcher a read flag per event: the ambient half's read state is one mark per
   membership (D-088).
8. **Dates**: a date-only value is midnight UTC and read in UTC (D-067).
   `dueHasTime` decides. Never format one without asking.

## Where things are

| Need | File |
|---|---|
| The view compiler — read before touching querying | `packages/core/src/views/compile.ts` |
| Field type system (20 types declared once) | `packages/core/src/fields.ts` |
| Operations, invert, undo stack | `packages/core/src/mutations.ts` |
| Permission rule (pure) | `packages/core/src/access.ts` |
| Rich text / mentions | `packages/core/src/richtext.ts` |
| Who gets notified (pure) | `packages/core/src/notifications.ts` |
| The executor — all writes land here | `packages/db/src/mutations.ts` |
| Authorization checks | `packages/db/src/task-access.ts` |
| Comment reads (writes are operations) | `packages/db/src/comments.ts` |
| Fan-out + inbox queries | `packages/db/src/notifications.ts` |
| The inbox screen and its badge | `apps/web/src/server/inbox.ts`, `app/inbox/page.tsx` |
| What a group of changes reads as (pure) | `packages/core/src/activity.ts` |
| Schema | `packages/db/src/schema/` |
| Seed — the demo workspace | `packages/db/src/seed.ts` |
| Loading a view for any renderer | `apps/web/src/server/views.ts` |
| Task detail loader | `apps/web/src/server/task.ts` |
| Server actions (the API boundary) | `apps/web/src/server/*-actions.ts`, `actions.ts` |
| Shared page chrome | `apps/web/src/components/app-shell.tsx` |
| The one hook every writing control uses | `apps/web/src/components/use-task-action.ts` |
| All styles | `apps/web/src/app/app.css` (tokens in `packages/ui/src/tokens.css`) |

## Conventions

- **Log every non-obvious call in `DECISIONS.md`** — the choice, the rejected
  alternatives, the trade-off accepted. Next id continues the sequence. Written
  to be explained out loud.
- **Commit and push each verified chunk**, on `main`. Do not batch.
- **Four gates before any commit**: `npm test`, `db:smoke`, `check:actions`,
  `typecheck` — plus driving it in Chrome for anything with a UI.
- A new check should **fail if the fix is reverted**. Verify that it does.
- Infrastructure stays on AWS/GCP or self-hosted Docker. No Vercel, no hosted
  database vendors, no auth SaaS.

## Environment gotchas that cost real time

- **The first click after a navigation is swallowed** while the dev server
  hydrates. It looks exactly like a broken handler. Click twice, or wait.
- **Synthetic drags do not trigger HTML5 drag-and-drop.** `left_click_drag`
  fails on the board *and* the calendar — that is the tool, not the app. Verify
  drag by dispatching real `DragEvent`s and checking Postgres.
- Port 3000 is another project. `check:actions` defaults to it and fails with a
  404 that looks like a missing route.
- `npm run docker:up` fails — the Compose plugin is not installed. Use the
  `docker start arbor-pg` line above.
- Deleting a `grants` row does **not** update `access_index`. Revoke properly or
  clear both, or the next thing you check sees stale access.
- **Postgres's clock is not this machine's.** It runs in the Colima VM and
  drifts tens of milliseconds either way. A check that fences on `activity.at`
  with `new Date()` lets the previous section's writes through at random — take
  the fence from `SELECT now()`.
- **`activity.field` is the SQL column name** (`status_id`), not the operation's
  (`statusId`) — and for a comment it is the *comment id*, and for a custom
  field the field id. Read the verb first; anything that reads `field` without
  asking ends up printing a uuid at somebody.
