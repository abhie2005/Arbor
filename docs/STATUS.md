# Status — resume here

Last updated 2026-09-05 (browser-verified). Repo: https://github.com/abhie2005/Arbor (`main`).

This file exists so a new session, or a future you, can pick the project up
without re-deriving anything. Update it whenever you stop mid-stream.

---

## No open bugs

The undo bug that headed this file for two days is **fixed and verified**
(D-049). The root cause was not in either place the previous two fixes looked.

**What it was.** The server returns the *inverse* of what it applied (D-036),
because only the server knows the value a field held before the write. The
client's `UndoStack` was modelled the textbook way — store operations as
applied, invert them on pop. So the client pushed an inverse into a stack that
inverted it again, and undo re-applied the original change. The task was already
in that state, so the row did not move; `from` and `to` still differed, so it
was not filtered as a no-op and reported success. Hence "it says it undid, but
it didn't".

**Why every test passed.** Each layer was correct in isolation and tested in
isolation: `invert` has 24 unit tests, `db:smoke` inverts the forward operation
(the correct single inversion), and `UndoStack` had seven tests that all pushed
forward operations. The defect existed only in the seam between two layers, and
nothing crossed it.

**How it was found.** By sending the `undo` server action the exact request a
click sends, then checking Postgres. The write landed *and* the response carried
a refreshed payload — which eliminated both hypotheses this file had been
holding and left only what the client had put in the request.

That technique is now `npm run check:actions` (D-048), and it includes an undo
regression check. Reverting the fix makes three unit tests and two action checks
fail with the original symptom.

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
npm test                                       # 260 unit tests, no database needed
npm run db:seed && npm run db:smoke            # 90 checks against real Postgres
PORT=3100 npm run check:actions                # 31 checks — needs the dev server
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

**Verified:** 260 unit tests, 90 live-Postgres checks, 31 server-action checks,
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

Four renderers, one query. Gantt is the remaining shape, and it is the one most
likely to break the bet: a bar spanning two dates is not a row at a point, and
the compiler has no notion of a range.

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

---

## What is deliberately not built

- `apps/realtime` and `apps/worker` — empty directories with no `package.json`.
  Neither earns its keep until there are mutations to broadcast and automations
  to run. The README describes them; that is aspirational, not current.
- `packages/sdk` — empty. Needed once there's an API worth a typed client.
- Real auth, permissions UI, guests — Phase 5.
- Every view renderer except List, Board, Table and Calendar.
- Docs, chat, dashboards, goals, time tracking, automations, AI.
- Derived field types (`formula`, `rollup`, `automatic_progress`) are declared
  and filterable, but nothing computes them yet — that is worker work.

---

## Where to pick up

**Phase 5 is done.** Both halves: the rule that decides who sees what is a pure
function with 26 tests and the index is rebuilt inside the transaction that
changes a grant; and sign-in is real, with scrypt hashes and server-side
sessions. Nothing in the app is pretending any more — the dev switcher is a
convenience layered on top of real sessions rather than a stand-in for them.

**Phase 6 is done.** Five renderers over one compiler. The timeline answered
the open question: the bet held on the part that mattered — no renderer has a
query of its own — but it did *not* hold that the compiler could already say
everything a renderer needs. Overlap required nested filter clauses, so the
compiler grew them (D-078). A renderer finding a gap and the query layer
closing it is the system working; the next renderer inherits the fix.

**Next — the task detail panel.** Every row in five renderers is a dead end:
there is no way to open a task. D-031 already decided it is a route rather than
a modal. It is also the thing comments will live in, so it is the honest first
step of Phase 7 rather than a detour from it.

**Then collaboration (Phase 7)**, unblocked for the first time — every fan-out
needs "whoever can see this thing", and that is now a join against a table that
is correct.

Table and Calendar landed 2026-09-05; permissions, sharing and real auth on
2026-09-06.

**Gantt, when it comes, is the renderer most likely to break the bet.** A bar
spanning start to due is not a row at a point, and nothing in the compiler
expresses a range. Worth thinking about before building it: a Gantt row is
probably still one task row, with the renderer doing the arithmetic — the same
answer the calendar reached — but dependencies between bars are a genuinely new
query.

**Then:** real auth and permissions (Phase 5 — the README roadmap puts access
control ahead of collaboration, because every collaborative feature fans out to
whoever can see a thing and building that on a dev stub means writing it
twice).

**Loose ends worth knowing about.**

- The filter bar offers `in` and `nin` ("is any of" / "is none of") in its
  operator menu, but the value control is still single-select — picking several
  values is not possible from the UI yet, though the compiler, the URL codec,
  and `parseFilterValue` all handle arrays. A value-control feature, not a
  plumbing one.
- **The timeline is read-only.** No dragging a bar to reschedule, and no
  dependencies between bars — the second needs a relations model that does not
  exist yet, and is the one genuinely new query a timeline could want.
- **Unscheduled tasks have nowhere to go on the calendar.** The month filter
  excludes tasks with no date, which is correct, but the usual way to schedule
  one is to drag it in from a tray. There is no tray.
- **The calendar shows every task in a square, however many there are.** No
  "+3 more" overflow, so a busy day grows its row. Worth fixing when a real
  workspace makes it visible.
- **Column widths are read but never written.** `resolveColumns` honours a
  stored `width` and clamps it; nothing in the UI sets one, so every column
  keeps its default except `name` in the seeded table view. Dragging a header
  edge is the obvious next thing and needs a pointer-drag and a save on release.
- **The table is flat.** It overrides `grouping` to `none`, because a grouped
  table means header rows spanning every column and that is a renderer feature,
  not a compiler one. The definition already carries the grouping.
- **Only the table reads `?s=`.** `loadView` takes a sort parameter but the
  list, board and calendar pages do not pass one, so hand-editing `?s=` on those
  does nothing. Harmless — the tab strip strips it when switching views — but it
  is an inconsistency waiting to confuse someone.
- **Four pages, one shell.** Each renderer page carries its own copy of the
  sidebar, header and error states — around sixty lines, now quadrupled. This
  was flagged at three and got worse; extract it before the fifth.

---

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
| `DECISIONS.md` | 66 entries. Every non-obvious choice, the alternatives rejected, and the trade-off accepted. Written for explaining the project out loud. D-049 is the most interesting one to talk through. |
| `docs/decisions/` | Five ADRs — the structural choices most expensive to reverse. |
| `docs/design-plan.html` | Interface plan: palette, type, density, screens, keyboard map, AWS topology. Open in a browser. |
| `docs/work-os-research.html` | The architecture teardown the whole project is built from. |
| `packages/core/src/views/compile.ts` | The heart of the product. Read this before changing anything about querying. |
| `packages/core/src/fields.ts` | The field type system. Everything about a custom field is declared here once. |
| `packages/core/src/views/columns.ts` | What a `ColumnSpec` becomes. Strict on write, lenient on read, and the reason that is not inconsistent. |

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
  timezone. That belongs with real identity in Phase 5.
- **Where a column set belongs when a view is personal.** Changing columns
  writes to the saved view for everyone (D-066), which is right for a shared
  view and possibly wrong for a shared view someone is borrowing. The escape
  hatch today is "Save as new" as a personal view. If people start doing that
  routinely, per-viewer column state is the real answer.
- **Grouped tables.** The definition carries `grouping` and the table ignores
  it. Deciding between header rows and a collapsed-section renderer is worth
  doing before the calendar, since the calendar groups by day.
