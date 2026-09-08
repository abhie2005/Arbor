# Status — resume here

Last updated 2026-09-07 (browser-verified). Repo: https://github.com/abhie2005/Arbor (`main`).

This file exists so a new session, or a future you, can pick the project up
without re-deriving anything. Update it whenever you stop mid-stream.

---

## No open bugs

Two were found and fixed during this pass, both by looking rather than by
reasoning.

**Writes were never authorized.** Reads have been permission-scoped since ADR 3
— every view query joins `access_index`, so a task in a list you cannot reach
never reaches a screen. Writes only ever established *who* was asking. Six
actions called `requireUser` and then wrote, and `undo` was the worst of them:
it takes an `Operation[]` straight from the client, so a hand-built batch could
name any task in the workspace. It survived five phases because it was
unreachable in practice — the only way to get a task id was to render a row, and
rendering was scoped. The detail page is what made it reachable, so it had to be
closed before the page landed (D-080).

**And closing it was not a fix until the sharing actions were closed too.**
`shareContainerAction` let any signed-in user grant themselves `manage` on any
container, so the task check was one extra request away from irrelevant: grant,
then edit legitimately. `check:actions` now performs exactly that sequence —
reverting the fix renames a task in a private list to "Renamed after granting
myself access" (D-081).

**A breadcrumb read "Founders › Founders › Hiring".** A list sitting directly
under a space matched that space as its folder as well, because the join had no
`kind` test. Invisible until a page existed for a task in a folderless list.

---

## Get running in 3 commands

```bash
colima start                                   # Docker daemon (Colima on this Mac)
docker start arbor-pg || docker run -d --name arbor-pg \
  -e POSTGRES_USER=arbor -e POSTGRES_PASSWORD=arbor -e POSTGRES_DB=arbor \
  -p 5432:5432 postgres:17-alpine
cd apps/web && npx next dev -p 3100
```

Then `http://localhost:3100`, which now asks you to sign in: **any seeded user,
password `arbor-demo-2026`** (the seed prints it). The login screen shows the
demo credentials in development only. **Port 3000 is usually taken by another project on
this machine** (`tempo`) — check before assuming a page you are looking at is
Arbor. First compile is around 6 seconds once `.next` exists; the "~5 minutes"
noted here previously was a cold cache.

Verify without the browser:

```bash
npm test                                       # 291 unit tests, no database needed
npm run db:seed && npm run db:smoke            # 112 checks against real Postgres
PORT=3100 npm run check:actions                # 65 checks — needs the dev server
```

`check:actions` is the only one that needs a running server: it POSTs to the
page with a `Next-Action` header, which is the request a button click makes.
**Pass `PORT=3100`** — it defaults to 3000, which is another project on this
machine, and the failure it gives you is a 404 rather than a wrong-app warning.

---

## What works today

| Area | State |
|---|---|
| **Schema** | 43 tables, 9 enums, 116 indexes. Migrated (0000, 0001) and seeded. |
| **View compiler** | Definition → one parameterized SQL query. Filters, grouping, sorting, group counts, permission scoping. Custom fields resolve through a required field catalog. |
| **Hierarchy** | Config inheritance, effective privacy, denormalized ancestors, move-legality. |
| **Ordering** | Fractional indices — one row written per drag. |
| **Mutations** | Invertible operations, one transaction per batch, activity row per change. **Undo works.** |
| **List view** | Renders through the compiler. Status cycling, priority cycling, inline rename, archive, inline create, undo. |
| **Board view** | Same compiler, `grouping.field = status`. Drag between and within columns, one row written per drag, one undo entry per drag. |
| **Table view** | Same compiler again, and the first renderer to read a definition's `columns`. Built-in and custom-field columns, sortable headers with the saved order one click away, and a chooser to show, hide and reorder. Status, priority, rename and archive work in the cells. |
| **Calendar view** | Month grid over the same query, narrowed to the six weeks on screen. Paging by month lives in the URL; dragging a task to another day reschedules it, with undo. `settings.dateField` picks which date the squares mean. |
| **Timeline (Gantt)** | Bars from start to due across a month of day columns. The renderer that made the compiler learn nested filter clauses, because "overlaps this window" is irreducibly mixed AND and OR. Read-only so far — no dragging, no dependencies. |
| **Filters** | Conditions may nest, so a clause can say `(a OR b) AND (c OR d)`. The filter bar and the URL stay flat; nesting exists for renderer scope. |
| **Dates** | A due date flagged as a calendar day is stored at midnight UTC and read in UTC, everywhere. Overdue means the day is over, not that the clock has passed midnight. |
| **Saved views** | The tab strip is the list of saved views. Create, rename, duplicate, set default, delete — validated by compiling the definition before it is written. Personal views are invisible to others. |
| **Filter bar** | On all three renderers. Menus are built from the same declaration the compiler validates against, so an invalid filter cannot be expressed. Filter state lives in the URL and is shareable; a malformed link errors instead of showing everything. |
| **Field types** | All 20 declared in one place: storage column, legal operators, config parser, value parser. |
| **Status sets** | CRUD, inheritance resolution, four templates, reordering, and task migration on delete. |
| **Custom fields** | CRUD, per-type config, placement down the tree, task-type scoping, archive, and type change with a real value migration. |
| **Task types** | CRUD, one default per workspace, deletion with reassignment. |
| **Settings UI** | `/settings` — statuses, custom fields, task types. |
| **Permissions** | Grants are the source of truth; a pure rule in `@arbor/core` flattens them plus inheritance into the access index every query joins against. Private containers, inherited grants, group grants, role baselines. Rebuilt inside the transaction that changed the grant, so a revocation has no stale window. |
| **Sharing UI** | `/settings/sharing` — the container tree with how many people each one reaches, a private toggle, and share/unshare. Inherited grants are shown with their source and are not removable there. |
| **Identity** | Real sessions: scrypt password hashes, a `sessions` row per sign-in with the token stored only as a hash, an httpOnly cookie, and a login screen. Every screen redirects to `/login` without one. The dev user switcher survives *underneath* sessions and applies only when explicitly set. |
| **Authorization** | Every server action authorizes as well as authenticates. Task writes join `access_index` for the actor; `undo` checks every task its client-supplied batch names; sharing and configuration need an owner or admin; a saved view is the container's `edit`, unless it is personal, in which case only its owner. |
| **Task detail** | `/t/ENG-402` — a page, keyed by the human key with a uuid fallback. Status, priority, dates, type, assignees, watchers, eleven editable custom-field types and a description. Subtasks are listed here and nowhere else in the UI. A viewer without `edit` gets values, not disabled controls. |
| **Comments** | Threaded one level, edit and soft-delete your own, `@` mentions stored as nodes carrying a user id. Written as operations, so each has an activity row and ⌘Z undoes it. Mentioning someone without access asks before granting them any. |

**Verified:** 291 unit tests, 112 live-Postgres checks, 65 server-action checks,
four packages typechecking clean, and the interactions above driven in Chrome.

**The permission checks are the ones to read.** They assert the property
through a compiled view query — a task in a private list not coming back —
rather than by inspecting the access index, because the index being right is
not the thing that matters. The seed now computes the index with the real job
instead of writing "everyone can manage everything" by hand, which is what made
it possible to have a permission bug the demo could not show.

**The renderer bet, measured twice.** The board took no compiler change, no new
SQL, and one new server action (`moveTask`, because dragging is a mutation the
list never needed).

The table is the more interesting measurement, because it is the first renderer
that needed something the compiler did not have. It runs the list's query
unchanged — no new SQL shape, no new join, no second query for rows — but it
needed two things beside it: four more built-in columns in the SELECT list
(D-061), and a per-page lookup for custom field values, which are one row per
(task, field) in the EAV table and cannot be projected without a subquery each
(D-062). Both live in the compiler and the shared read path respectively;
neither is a query belonging to a renderer, which is the line that matters.

**The calendar settled it.** It is the first view whose shape is not a sequence
of rows, and it needed no compiler change and no new SQL — a month is the
list's query with one condition appended, using the `between` operator that was
already there (D-068). What it did need was `loadView` learning that a renderer
may *narrow* the query in a way the URL cannot widen back, and a page size
raised to the compiler's maximum, because a month is a bounded window rather
than a page someone scrolls.

Five renderers, one query — and the detail page is the first screen that does
*not* go through the compiler, which is the boundary rather than an exception.
A view compiles "which rows"; a task page already knows the row. What it could
not skip was the `access_index` join the compiler had been providing for free
on every other screen (D-082).

**Browser-verified 2026-09-05**, the first time in this project's history:
board drag lands where aimed, undo restores both the column and the place in
it, ⌘Z works from the keyboard, status cycling works, the status deletion
prompt reports how many tasks would move, and a duplicate status name is
refused with the input snapping back.

It found three bugs that every automated check had passed — a toast that
counted operations and called them tasks, a drop handler that read the dragged
id from React state instead of `dataTransfer`, and refused edits that left the
rejected value in the input (D-052, D-053). None of them were reachable from
the server side, which is the whole argument for looking at the screen.

**The table was verified the same way**, and it earned its keep again: a
malformed `?s=` link reported "Could not reach the database" and told you to
start Docker; sortable headers were only clickable on the words themselves,
leaving most of each header cell dead; and putting the column chooser beside
the filter bar collapsed the bar to content width, stranding its "Show closed"
toggle mid-row. All three passed every automated check.

**The calendar found two more**, one of them older than it: every date-only due
date displayed a day early (D-067), which was invisible until a task had to sit
in a square; and the sidebar's task count was whatever the renderer had drawn,
so an empty month reported the list as empty (D-069).

**The detail page found one older than the whole feature**, and it is the same
shape: a list sitting directly under a space matched that space as its folder
as well, because the join had no `kind` test. It had been in `loadView` since
the beginning and could not be seen, because the only list the app rendered had
a real folder. A page for a task in a folderless list is what made "Founders ›
Founders › Hiring" appear on screen.

Two things worth noting about verifying this pass in a browser. **A synthetic
drag does not trigger HTML5 drag-and-drop**: the calendar and board drags both
fail under `left_click_drag`, which is the tool and not the app — the calendar
drop was confirmed by dispatching real `DragEvent`s and checking Postgres.
And **the first click after a navigation is still swallowed** while the page
hydrates, which cost twenty minutes here on a checkbox that looked broken and
was not.

---

## What is deliberately not built

- `apps/realtime` and `apps/worker` — **not even directories any more.** The
  README names them; that is the shape being decided, not code that exists.
  Neither earns its keep until there are deltas to broadcast and automations to
  run, and the transport question above has to be settled first.
- `packages/sdk` — empty. Needed once there's an API worth a typed client.
- Notifications, realtime deltas and presence — the rest of Phase 7.
- Docs, chat, dashboards, goals, time tracking, automations, AI.
- Derived field types (`formula`, `rollup`, `automatic_progress`) are declared
  and filterable, but nothing computes them yet — that is worker work.

---

## Where to pick up

**Phase 7 is half done.** The task detail page and comments are built; what
remains is the fan-out half — notifications, then realtime, then presence.

The pass ran as four commits, each verified on all four gates before the next
started: the shell extraction, authorization, the detail page, comments.

### Next — notifications

This is the honest next step, and it is where the schema has been waiting.
`notifications` exists and is empty. The comment on the table says what it is
for: **write-time fan-out for direct signals only** — assigned, mentioned,
replied — with ambient activity aggregated at read time from `activity`,
because a task with 200 watchers would otherwise write 200 rows per edit.

Most of what it needs already landed:

- **Mentions are already references.** `mentionedIds(doc)` returns the user ids
  a comment named, and it is called today only to decide whether to ask about
  sharing (D-084). The fan-out is the second caller.
- **Watchers are real and get added.** Commenting makes you a watcher, and the
  panel has checkboxes for both watchers and assignees. `task_watchers` was
  seeded and unread before this pass; it is now the list to fan out to.
- **`payload` is meant to be rendered, not joined.** The schema says the inbox
  row should need no joins to display, which means writing the summary at
  fan-out time. `renderPlain(doc)` is what produces it.
- **The sidebar's `Inbox 3` is hardcoded.** It is a literal `3` in
  `components/app-shell.tsx`, marked with a comment. That badge and an
  `/inbox` page are the visible half.

**The one thing to decide first** is whether notifications are written inside
the same transaction as the operation that caused them. Inside is correct and
makes a comment's write proportional to its watcher count; outside needs
something to run it, and `apps/worker` does not exist. That is the same shape of
decision as D-071 (a rebuild per share), and it should be made deliberately
rather than by whichever is easier to write.

### Then realtime, and presence

Neither is started, and the transport is undecided — that is the first question,
not an implementation detail:

- **`revalidatePath` only**, which is what happens today. Correct and not live.
- **SSE from a Next route handler** over Postgres `LISTEN/NOTIFY`. No new
  deployable, no Redis. Broadcasting a "task X changed" nudge that triggers
  `router.refresh()` is far cheaper than sending deltas and fits server
  components; deltas are what a CRDT editor needs and Docs are Phase 9.
- **`apps/realtime` as a real WebSocket service** with Redis pub/sub. It is
  named in the README and does not exist as a directory. Presence needs this or
  SSE; it cannot be done with revalidation.

**Every fan-out needs "whoever can see this thing"**, and that is now a join
against a table that is correct and that writes are checked against too — which
is why access control went before collaboration.

### Known gaps in what was just built

- **Reactions and comment resolve/assign are not built.** `comment_reactions`
  exists; `resolvedAt` and `assignedTo` are columns nothing sets. Resolve/assign
  is deliberately held for the notifications pass, since assigning a comment is
  a fan-out signal and belongs with the machinery that delivers it.
- **Nine custom field types are read-only on the detail page** — the
  multi-valued ones (labels, users, tasks), the derived ones, and location,
  relationship and manual progress. Each renders as a value with a `title`
  saying why, rather than as a control that does nothing.
- **Tags are not editable anywhere.** `RelationOp` supports them and there is no
  picker and no creation path in any screen.
- **`task_links` is still unused.** Dependencies belong with a draggable
  timeline, which is also not built.
- **The detail page is a full page, not an overlay.** D-031's shape is a panel
  over a mounted list; that needs the five renderers moved into one route group
  first (D-082). The address is the part that was expensive to get wrong, and it
  is right.
- **Activity is not shown anywhere.** Every operation writes a row and no screen
  reads one. A history section on the detail page is a small piece of work and
  the obvious companion to comments.
- **No comment counts on rows or cards.** `commentCounts` exists in
  `packages/db/src/comments.ts` and nothing calls it — it was written for the
  badge that has not been added.

### Loose ends from earlier phases, still open

~~**Four pages, one shell.**~~ Fixed (D-079) — `components/app-shell.tsx`, and
the four copies had already drifted apart before it was extracted.

- **The filter bar offers `in` and `nin` with a single-select value control.**
  The compiler, the URL codec and `parseFilterValue` all handle arrays; only the
  control does not.
- **The timeline is read-only.** No dragging a bar to reschedule, and no
  dependencies — the second needs `task_links` read, which nothing does.
- **Unscheduled tasks have nowhere to go on the calendar.** The month filter
  excludes tasks with no date, which is correct; the usual way to schedule one is
  to drag it in from a tray, and there is no tray.
- **The calendar shows every task in a square, however many there are.** No
  "+3 more" overflow, so a busy day grows its row.
- **Column widths are read but never written.** `resolveColumns` honours a
  stored `width` and clamps it; nothing in the UI sets one.
- **The table is flat.** It overrides `grouping` to `none`; the definition still
  carries the grouping. Header rows spanning every column is a renderer feature.
- **Only the table reads `?s=`.** `loadView` takes a sort parameter and the
  list, board and calendar pages do not pass one, so hand-editing `?s=` on those
  does nothing.


## Environment gotchas on this machine

- **Port 3000 is another project.** Use 3100 for Arbor.
- **Docker Compose plugin is not installed** — only the Docker CLI. So
  `npm run docker:up` fails. Fix with `brew install docker-compose`, or keep
  using the `docker run` line above. The compose file itself is correct.
- **Colima must be started manually** (`colima start`) and is slow on disk.
- **`check:actions` defaults to port 3000**, which is `tempo`. Run it as
  `PORT=3100 npm run check:actions` or it fails with a 404 that looks like a
  missing route rather than the wrong app.
- **pnpm and corepack are absent**, which is why this is an npm-workspaces repo
  (D-004). The root `packageManager` field pins npm — Turborepo 2.10 refuses to
  resolve the workspace without it.
- **The Claude-in-Chrome extension** refused to connect for four sessions and
  then worked on 2026-09-05. `check:actions` exists because of that history and
  is still worth keeping: it runs without a browser and covers the server half.
- **Dev-server hydration takes several seconds.** Clicking or typing too soon
  after a navigation does nothing at all — the event never reaches React, and
  it looks exactly like a broken handler. Wait for the page to settle before
  concluding anything from an interaction that did not work.
- **21st.dev MCP** is configured at local scope in `~/.claude.json` (not in the
  repo — the key must never be committed). **Its tools require a Claude Code
  restart to load.** Not yet used; `packages/ui` has the tokens and an empty
  `ATTRIBUTIONS.md` waiting.

---

## Read these first

| File | Why |
|---|---|
| `DECISIONS.md` | 84 entries. Every non-obvious choice, the alternatives rejected, and the trade-off accepted. Written for explaining the project out loud. D-049 is the most interesting one to talk through; D-080 and D-081 are the pair worth reading together, because the first was not a fix until the second landed. |
| `docs/decisions/` | Five ADRs — the structural choices most expensive to reverse. |
| `docs/design-plan.html` | Interface plan: palette, type, density, screens, keyboard map, AWS topology. Open in a browser. |
| `docs/work-os-research.html` | The architecture teardown the whole project is built from. |
| `packages/core/src/views/compile.ts` | The heart of the product. Read this before changing anything about querying. |
| `packages/core/src/fields.ts` | The field type system. Everything about a custom field is declared here once. |
| `packages/core/src/views/columns.ts` | What a `ColumnSpec` becomes. Strict on write, lenient on read, and the reason that is not inconsistent. |
| `packages/db/src/task-access.ts` | The check every write goes through. Two refusals, on purpose: unreachable reads as gone, insufficient says so. |
| `packages/core/src/richtext.ts` | The document format comments and descriptions share, and why a mention is a node rather than characters. |

---

## Open questions

- **Enterprise features** — in the open repo, or a separately-licensed `ee/`
  directory? Decide before writing the first line of SSO; choosing afterwards
  means an awkward public relicensing.
- **Hiding an inherited field.** Fields accumulate down the tree and cannot be
  suppressed lower (D-046). If a real case appears, it should be an explicit
  per-container suppression rather than a change to the inheritance rule.
- ~~**`columns` is written but never read.**~~ Answered by the table: read on
  every render, editable from the chooser, validated on write (D-060, D-066).
  What is still open is **width** — stored and honoured, never set by anyone.
- **Multi-select filter values.** `in`/`nin` are offered but the value control
  picks one value. Everything beneath it already handles arrays.
- **Two position columns.** `tasks.position` and `task_lists.position` both
  exist; only the first is read for ordering, and the board writes it. They
  diverge the moment a task can sit at a different place in two lists, which is
  what `task_lists` exists for (D-010). Decide which is authoritative before
  building multi-list ordering, not after.
- **Keyboard and touch on the board.** Native drag has neither (D-051). Moving
  between statuses has a keyboard path already; reordering within a column does
  not.
- **No password reset, and no way to create an account.** Sign-in works; the
  rest of the account lifecycle does not exist. Reset needs email, which the
  compose file already runs (Mailpit) and the reference deployment already
  names (SES) — it is a flow, not an infrastructure decision.
- **Every `check:actions` run leaves a session row.** Harmless, and
  `purgeExpiredSessions` only takes expired ones. Worth a cleanup in the script
  eventually.
- **Groups have no UI.** The model supports group grants and the sharing panel
  offers them, but nothing creates a group or puts people in one, so the demo
  has none. `user_groups` and `user_group_members` are seeded empty.
- **A rebuild per share.** Every grant recomputes the whole workspace's index
  inside the transaction (D-071). Correct, and it stops being cheap somewhere
  around a thousand lists — `affectedLists` exists for that day.
- **An instant still has no timezone to be read in.** D-067 fixed calendar
  days, which have one right answer. A due date *with* a time is rendered in the
  server's zone during SSR and the browser's afterwards, and users carry no
  timezone. Identity is real now, so this has run out of excuses.
- **Sharing is a workspace role, and should be a container permission.** A team
  lead who makes a private space cannot share it without being a workspace
  admin (D-081). That is wrong, and wrong in the safe direction. The fix is for
  `resolveAccess` to emit container permissions alongside its list rows, which
  changes the pure rule and its 30 tests — worth doing deliberately.
- **Notifications inside the transaction, or outside it?** Inside is correct and
  makes a comment's write proportional to its watcher count. Outside needs
  something to run it, and there is no worker. Same shape as D-071; decide it
  before writing the fan-out, not after.
- **⌘Z removes a comment you just posted.** A deliberate consequence of comments
  being operations (D-083), and the honest one. If it turns out to surprise
  people badly enough to matter, the fix is a stack that knows which entries are
  comments rather than a comment that is not an operation.
- **Where a column set belongs when a view is personal.** Changing columns
  writes to the saved view for everyone (D-066), which is right for a shared
  view and possibly wrong for a shared view someone is borrowing. The escape
  hatch today is "Save as new" as a personal view. If people start doing that
  routinely, per-viewer column state is the real answer.
- **Grouped tables.** The definition carries `grouping` and the table ignores
  it. Deciding between header rows and a collapsed-section renderer is worth
  doing before the calendar, since the calendar groups by day.
