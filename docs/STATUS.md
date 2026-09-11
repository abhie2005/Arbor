# Status — resume here

Last updated 2026-09-11 (Phase 8 complete). Repo: https://github.com/abhie2005/Arbor (`main`).

**`CLAUDE.md` at the repo root is the map** — invariants, where things live,
commands, gotchas. It loads automatically. This file is only *current state and
what is next*, so start here when resuming and do not read the tree to orient
yourself.

**No open bugs.** The archaeology of the ones that are fixed, and what browser
verification found in each phase, is in `docs/HISTORY.md`.

---

## What works today

| Area | State |
|---|---|
| **Schema** | 43 tables, 9 enums, 117 indexes. Migrated (0000–0008) and seeded. |
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
| **Notification fan-out** | Written inside the transaction that caused them, for direct signals only: assigned, mentioned, replied. Never to someone who cannot open the task, and the inbox filters again on read because access can be revoked afterwards. Rule is pure and in core. |
| **Inbox** | `/inbox` — the first screen not scoped to one container, permission-scoped per row rather than per page. Unread and everything, opening a row marks it read and goes to the task, mark-read without opening, mark all read. The sidebar badge is the real count, fetched by the shell on every screen (D-085). Read state writes outside the operation layer, deliberately (D-087). |
| **History** | The activity log's first reader. Every operation has written a row since Phase 2 and no screen read one; the detail page now shows what happened to a task, newest first, with ids resolved to names from what the page already loads (D-091). Scoped by the same `access_index` join as every other read. |
| **Presence** | Who else is looking at a task, pushed down the same stream. The connection *is* the signal — no table, no heartbeat, nothing to sweep, and gone the instant a tab closes (D-092). A scope is checked with `taskAccess` before a stream is registered on it. Per-process: a second instance would not see the first's viewers. |
| **Live updates** | Every screen holds an `EventSource` to `/api/live`. A change announces itself with `pg_notify` inside the transaction that made it, so a rollback announces nothing; the route handler checks each nudge against the viewer's access before it leaves, and the browser answers with `router.refresh()` (D-090). A nudge carries the workspace, list and actor — never what changed. |
| **Time tracking** | Start and stop on the task page, an entry list, logging time after the fact, and tracked-against-estimate. Every write is an operation (D-093), so ⌘Z undoes a stop and restores a deleted entry. At most one running timer per person, held by a unique partial index (D-094). A readout in the shell of every screen, pushed down the live stream so a timer started in another tab appears in this one (D-098). |
| **Goals** | `/goals` — goals with key results of four kinds. A *rollup* key result holds a view definition and is counted by the compiler (D-101), so a goal and a list can never disagree about what counts; it is computed as the goal's **owner** rather than the reader (D-102), which is what makes progress a shared fact. Manual, currency and yes/no key results are entered. Progress is the mean of the key results, each clamped; completion is a timestamp somebody set, not a number crossing 100%. |
| **Dashboards** | `/dashboards` — a grid of cards, each a filter plus a way of drawing it. A card's `kind` *is* which compiler entry point it calls (D-104): a stat is `compileAggregate`, a chart is `compileGroupCounts`. Counted as the **viewer** (D-105), which is the opposite of a goal and for a reason. Scoped to a container, with personal dashboards following the saved view rule. Charts are HTML bars measured against the largest slice; no charting library. |
| **Ambient activity** | The read-time half. What happened on tasks you watch, assembled from `activity` at display time and grouped into one row per task, in one stream with the signals (D-089). Excludes your own actions, anything that already notified you directly, and movement that is not news. Read state is one mark per membership rather than a flag per event (D-088). |

**Verified:** 418 unit tests, 196 live-Postgres checks, 140 server-action checks,
four packages typechecking clean, and the interactions above driven in Chrome.

---

## What is deliberately not built

- `apps/realtime` and `apps/worker` — **not even directories any more.** The
  README names them; that is the shape being decided, not code that exists.
  The transport question is now settled and settled against `apps/realtime`:
  Postgres carries changes (D-090), presence within a process (D-092) and
  presence between them (D-100), all on one connection per process. `apps/worker`
  still has nothing to run.
- `packages/sdk` — empty. Needed once there's an API worth a typed client.
- Docs, chat, automations, AI.
- Derived field types (`formula`, `rollup`, `automatic_progress`) are declared
  and filterable, but nothing computes them yet. Time tracking did **not**
  change this: a tracked total is summed at read time, so the question of
  whether these ever need a worker is still open, and a key result over a filter
  is what will decide it.

---

## Where to pick up

**Phase 8 is done.** Time tracking, goals and dashboards are all built, which is
the last of the three tables that had been migrated in 0000 and never touched by
code. Phase 7's two leftovers are fixed too (D-099, D-100).

### Next — Phase 9, and the thing to settle before it

Phase 9 is **Docs**, and the decision it turns on is already visible: comments
and descriptions share one document format (`packages/core/src/richtext.ts`,
D-083), and a collaborative editor is the first thing that needs *operations on
a document* rather than a document as an operation's value. That is either a
CRDT (ADR 4 refused one for records, deliberately, and said nothing about text)
or operational transform over the existing block tree. Decide which before
writing an editor, because the storage shape follows from it and `docs` already
has a `content` column waiting.

**The two things Phase 8 leaves that are worth doing first**, both small and
both now cheap:

- **A tracked-time rollup.** `compileAggregate` totals `points` and
  `timeEstimate`, not time actually tracked, because that needs the compiler to
  reach `time_entries` — a correlated subquery, a few lines. It is the obvious
  link between the two halves of Phase 8 and the first thing anyone will ask a
  goal or a dashboard for.
- **The container permission** (D-081). This is now the third feature to route
  around it: sharing is a workspace role, goals have no privacy, and a
  space-scoped dashboard falls back to workspace-wide because `access_index`
  holds lists rather than containers. The fix is `resolveAccess` emitting
  container rows alongside its list rows, which changes the pure rule and its 30
  tests — worth doing deliberately, and worth doing before a fourth feature
  needs it.

### Done — dashboards

`dashboards` was the last untouched table.

- **A card's kind is which compiler call it makes** (D-104). A `stat` is
  `compileAggregate`, a `chart` is `compileGroupCounts`. Both entry points
  already existed — group counts from the board's column headers in Phase 4,
  aggregates from goal rollups — so dashboards added no query code at all.
  Adding a third kind means adding a third entry point rather than teaching one
  of these to sometimes return something else.
- **Counted as the viewer** (D-105), the opposite of a goal's rollup and for a
  reason: a goal has an owner on the row, a dashboard has a `container_id`, and
  the rule for what lives in the tree is that you see what you have a grant on.
  Two readers disagreeing is correct, and the footer says so.
- **Personal dashboards are the saved view rule verbatim** (D-057) — same
  columns, same rule, rather than a second one to keep in step.
- **A broken card costs one card.** `parseLayout` returns what parsed plus a
  count of what did not; the write path still throws.

**It found a compiler bug** (D-106): grouping by `assignee` emitted `ta.user_id`
into a query that never joins `task_assignees`, which compiled and then failed
in Postgres. `compileGroupCounts` had existed since Phase 4 and the board only
ever grouped by status. Grouping by a multi-valued field is now refused, and the
form offers single-valued axes only.

### Done — goals

- **`key_results.source` is a view definition** (D-101), so the compiler grew
  `compileAggregate` rather than the column growing a second query language.
- **A rollup is computed as the goal's owner** (D-102), so a shared commitment
  reads the same for everyone. An ownerless goal reads as unmeasured, not zero.
- **A goal is configuration** (D-103): no operations, no ⌘Z, owner-or-admin.

### Done — time tracking

- **Through `applyOperations`** (D-093), which bought the activity row, undo and
  the live nudge for free.
- **One running timer per person is a unique partial index** (D-094).
- **Stopping your own entry does not re-check task access** (D-095).
- **The estimate is task-level** (D-096); `task_estimates` stays empty.
- **An operation has to survive JSON** (D-097) — now an invariant.

### Done — the two things Phase 7 left

- **Nudges can be ignored** (D-099). The announcement moved from `logActivity`
  to `applyOperations` so the nudge could carry who the fan-out told.
- **Presence crosses processes** (D-100), with the check acting as the second
  process.

### Known gaps in what was just built

**Dashboards**

- **No list card.** A card that compiles to *rows* is the obvious third kind and
  is not built; it is the table renderer in miniature, and the honest version
  reuses `loadView`'s resolution rather than a third path.
- **Cards cannot be reordered or resized.** `layout` is an ordered array and
  order is the only layout; nothing moves an entry, and the grid auto-fits.
- **Charts cannot group by assignee** (D-106) — refused rather than broken, and
  "tasks per person" needs a renderer that can put one task in several bars.
- **The card form is a subset of what `layout` can hold.** Five metrics, five
  axes, one container. A filter builder would need no migration.
- **Nothing caches a card.** Every render recompiles and re-runs every card;
  twenty cards is twenty queries per page view.
- **A space-scoped dashboard is effectively workspace-wide**, because
  `access_index` holds lists. See the container permission above.
- **No live updates.** A dashboard does not refresh when the tasks it counts
  change; `/dashboards` passes no `lists` to `Live` so it refreshes on any nudge
  the viewer can hear, which is accidentally almost right and not by design.

**Goals**

- No privacy (every member sees every goal); one query per rollup; nothing
  cached; key results cannot be reordered; the rollup form is a subset; no
  screen reads a goal's activity; currency cannot be picked in the UI.

**Time tracking**

- No timesheet screen; `is_billable` collected and never read; time cannot be
  tracked against anything but a task; no rollup of tracked time anywhere;
  editing an entry moves its start and holds its end; an entry spanning midnight
  belongs to the day it stopped.

**Live and presence**

- A nudge is still evaluated per viewer at the route; presence does not survive
  a partition and does not say so; presence is only on the task page.

### Background — why notifications are shaped this way

Both halves are built now; this is the reasoning they were built from, kept
because it is what any change to either of them has to stay true to. The comment
on the table says what it is for: **write-time fan-out for direct signals
only** — assigned, mentioned, replied — with ambient activity aggregated at read
time from `activity`, because a task with 200 watchers would otherwise write 200
rows per edit.

What each piece contributes:

- **Mentions are already references.** `mentionedIds(doc)` returns the user ids
  a comment named, and it is called today only to decide whether to ask about
  sharing (D-084). The fan-out is the second caller.
- **Watchers are real and get added** — but they are *not* the write-time
  fan-out list, and reading them as one would undo the reason the table is
  designed this way. Watchers are who the **read-time** aggregation over
  `activity` is for. The rows written at write time go to people named
  directly: the assignee who was just assigned, the person a comment mentioned,
  the author of a comment that was replied to. Commenting makes you a watcher,
  and the panel has checkboxes for both — so both halves now have their input.
- **`payload` is meant to be rendered, not joined.** The schema says the inbox
  row should need no joins to display, which means writing the summary at
  fan-out time. `renderPlain(doc)` is what produces it.
- **The badge and `/inbox` are the visible half**, and both exist. The literal
  `3` in `components/app-shell.tsx` is now `unreadCount`, fetched by the shell
  itself (D-085).

**Written inside the transaction that caused them**, decided before the fan-out
was written and unchanged since: a comment and the fact that it notified someone
either both happened or neither did, and a fan-out lost to a crash leaves no
trace anywhere — nothing detects the silence. The usual objection is cost, and
it does not apply, because only *directly named* people get a row. Outside would
need something to run it, and `apps/worker` does not exist.

### Known gaps from Phase 7, still open

- **Presence is only on the task page.** A list does not show who is looking at
  it, deliberately — but a *task row* could show who has that task open, and
  that is a smaller change than it sounds now that the data is on the client.
- **Ambient read state is all-or-nothing** (D-088). "Mark all read" moves the
  mark; there is no way to dismiss one watched task's activity and keep
  another's. Per-task dismissal would be a table of what you have dismissed
  rather than a flag on what happened, and it is not written.
- **Opening an ambient row does not clear it.** It has no row to mark, so it
  stays until the feed is marked seen. Honest, and the first thing anyone will
  ask about.
- **The ambient window is fourteen days and does not page.** Activity older than
  that is not reachable from this screen at all — the task's own history would
  be the place for it, and no screen reads `activity` yet.
- **The two halves disagree about workspaces.** `loadInbox` is scoped to a
  person and not to a workspace; the ambient half has to name one, because its
  mark lives on the membership. With one workspace this is invisible. With two
  it is a bug, and the fix is to scope the direct half too.
- **`cleared_at` is a column nothing sets.** `loadInbox` honours it, so
  dismissing a notification without reading it is a control away, not a schema
  change. Held because "clear" and "mark read" both need to exist before either
  is worth designing.
- **The inbox is capped at 100 rows and does not page.** A queue, not an
  archive — but a busy month is more than a hundred signals, so the cap is a
  decision with a shelf life.
- **The badge is only as fresh as the last render.** `revalidatePath` updates it
  on every write that goes through an action, which means someone else's mention
  arrives when the page next renders. Live is what realtime is for.
- **`Home` and `My Work` in the sidebar are still placeholders.** The inbox is
  the first of those three entries to point anywhere.

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
- ~~**Activity is not shown anywhere.**~~ The detail page reads it now (D-091).
  What is still unread is activity on anything that is **not** a task —
  `container.shared` and the configuration verbs are written and have no screen.
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

---

## Background, when you want it

`CLAUDE.md` lists the source files that matter and what each is for. These are
the ones it does not cover, because they are reading rather than reference:

| File | Why |
|---|---|
| `DECISIONS.md` | 84 entries — every non-obvious choice, its rejected alternatives, and the trade-off accepted. Written to be explained out loud. D-049 is the best one to talk through; D-080 and D-081 are the pair to read together, because the first was not a fix until the second landed. |
| `docs/HISTORY.md` | What each phase cost, and the bugs that survived every automated check until someone looked at the screen. |
| `docs/decisions/` | Five ADRs — the structural choices most expensive to reverse. |
| `docs/design-plan.html` | Interface plan: palette, type, density, screens, keyboard map, AWS topology. Open in a browser. |
| `docs/work-os-research.html` | The architecture teardown the whole project is built from. |

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
- ~~**Notifications inside the transaction, or outside it?**~~ Inside, decided
  before the fan-out was written: only directly named people get a row, so the
  cost is proportional to who was named rather than to who is watching. What is
  still open is where the **read-time** half renders — a second section on the
  inbox, or one merged stream sorted across two sources with different shapes.
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
