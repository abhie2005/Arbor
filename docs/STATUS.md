# Status — resume here

Last updated 2026-09-10 (Phase 8: time tracking and goals). Repo: https://github.com/abhie2005/Arbor (`main`).

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
| **Schema** | 43 tables, 9 enums, 117 indexes. Migrated (0000–0007) and seeded. |
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
| **Ambient activity** | The read-time half. What happened on tasks you watch, assembled from `activity` at display time and grouped into one row per task, in one stream with the signals (D-089). Excludes your own actions, anything that already notified you directly, and movement that is not news. Read state is one mark per membership rather than a flag per event (D-088). |

**Verified:** 399 unit tests, 180 live-Postgres checks, 127 server-action checks,
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
- Docs, chat, dashboards, automations, AI.
- Derived field types (`formula`, `rollup`, `automatic_progress`) are declared
  and filterable, but nothing computes them yet. Time tracking did **not**
  change this: a tracked total is summed at read time, so the question of
  whether these ever need a worker is still open, and a key result over a filter
  is what will decide it.

---

## Where to pick up

**Phase 7 is closed** — both things it left behind are fixed (D-099, D-100).

**Phase 8 has time tracking and goals.** Dashboards are the rest of it and have
not been started.

### Next — dashboards

`dashboards` is the last of the three tables migrated in 0000 that nothing has
ever written to. Its columns say more than the other two did:

- **It has a `container_id`, and `goals` deliberately does not.** That is the
  schema saying a dashboard belongs somewhere in the tree while a goal belongs
  to the workspace — so a dashboard has an obvious permission story (the
  container's) that goals had to do without, and it should use it rather than
  copying D-103's owner-or-admin rule.
- **`layout` is "a grid of cards; each card is a saved query plus a chart
  spec".** The saved-query half is settled by the same argument goals settled
  (D-101): it is a view definition, compiled by the compiler, and `compileAggregate`
  already exists for the cards that are one number. The part that is genuinely
  new is the chart spec, and the question to answer first is whether a card
  compiles to *rows* (a chart) or to *one number* (a stat), because those are
  two different compiler calls and a card that could be either is a card whose
  renderer has to ask.

**Do not let a dashboard card grow a second query language**, for exactly the
reason a key result did not. If a card wants something the compiler cannot say,
the compiler grows.

The open question dashboards will force is **whose permissions a card reads
with**. Goals answered it with the owner (D-102) because a goal is a shared
commitment with an owner on the row. A dashboard sits in a container, so the
viewer is the defensible answer there — which means two people can see different
numbers on one dashboard, and that is correct rather than a bug. Decide it
before the first card, and say it on screen.

### Done — goals

Built this pass. `goals` and `key_results` had existed since migration 0000 with
nothing touching them.

The decisions, each logged:

- **`source` is a view definition** (D-101). The column was asking for a small
  query language and the compiler already is one, so it grew `compileAggregate`,
  which shares `buildBase` with the row query and the group counts. A second
  language would have been a second set of answers to "does this task count",
  and the cost would have been the day a goal said 12 and the list showed 14.
  Inline rather than bound to a saved view: a goal is a commitment, and a number
  that moves because somebody tidied their saved views moved without anyone
  deciding.
- **A rollup is computed as the goal's owner** (D-102), so everyone reading a
  goal reads the same number. The cost is real and named: an aggregate can
  include tasks the reader cannot open, though it can never name one. Computing
  it unscoped was rejected because the escape hatch is what the next caller
  reaches for.
- **A goal is configuration** (D-103), so it goes through the config services
  rather than `applyOperations` — an operation carries a `taskId` and a goal has
  no task. ⌘Z does not reach a goal, the same as it does not reach a status set.
- **An ownerless goal reads as unmeasured, not as zero.** `owner_id` is `ON
  DELETE SET NULL`, so it is reachable, and zero would be a claim that nothing
  had been done.

### Done — time tracking

Start, stop, log after the fact, correct, delete, and an estimate to measure
against, on `/t/KEY` and in the chrome of every screen.

- **It goes through `applyOperations`** (D-093), which bought the activity row,
  undo and the live nudge for free.
- **`duration_ms` is derived in SQL** from the two stored instants and is absent
  from every operation.
- **One running timer per person is a unique partial index** (D-094), migration
  0006 — not the service-layer rule the table comment asked for, which two tabs
  slip through.
- **Stopping your own entry does not re-check task access** (D-095).
- **The estimate is `tasks.time_estimate_ms`**; `task_estimates` stays empty
  (D-096).
- **An operation has to survive JSON** (D-097) — now an invariant in
  `CLAUDE.md`, found by `check:actions` after passing everything else.

### Done — the two things Phase 7 left

- **Nudges can be ignored** (D-099). The nudge carries who the fan-out told, and
  the announcement moved out of `logActivity` up to `applyOperations` to be able
  to say it. The list-only filter would have quietly broken the inbox badge.
- **Presence crosses processes** (D-100). Each process states its own set on a
  second Postgres channel and holds everyone else's with a TTL. The check *is*
  the second process, which is what answered D-092's objection to building it.

### Known gaps in what was just built

**Goals**

- **Goals have no privacy.** Every member sees every goal, because `goals` has
  no container to scope to. Scoping them would mean adding a `container_id` —
  which `dashboards` has and `goals` deliberately does not — so inventing one to
  paper over this would be re-deciding the schema by accident.
- **A rollup is one query per key result.** A screen of five goals with three
  each is fifteen small indexed aggregates. One `UNION ALL` is the fix available
  when that stops being cheap; it is not the shape to reach for first.
- **Nothing caches a rollup.** Every render recounts. That is the same bet the
  ambient inbox makes and it holds for the same reason, until a dashboard puts
  twenty of them on one screen.
- **Key results cannot be reordered.** `position` is written with a fractional
  index and nothing moves one.
- **The rollup form offers four metrics and a container.** `source` can express
  any view definition the compiler can compile; the form cannot. A real filter
  builder is the missing half, and the data model needs no migration for it.
- **No history screen reads a goal's activity.** `goal.created`, `goal.updated`
  and the key-result verbs are written and nothing displays them — the same gap
  every other configuration verb has.
- **Goals are workspace-scoped and the workspace is still the demo one.**
  `requireWorkspace()` looks up a slug.
- **A currency key result has no way to pick its currency in the UI.** The
  column and the parser handle it; the form always sends the default.

**Time tracking** (unchanged from the last pass)

- No timesheet screen; `is_billable` is collected and never read; time cannot be
  tracked against anything but a task; no rollup of tracked time to a parent or
  a list; editing an entry moves its start and holds its end; an entry spanning
  midnight belongs to the day it stopped.
- **A tracked-time rollup would be the obvious link between the two halves of
  Phase 8** and does not exist: `compileAggregate` totals `points` and
  `timeEstimate`, not time actually tracked, because that needs the compiler to
  reach a table outside `tasks`.

**Live and presence**

- A nudge is still evaluated per viewer at the route, one indexed lookup each;
  the D-099 filter is on the client.
- Presence does not survive a partition, and does not say so.
- Presence is only on the task page.

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

~~**Every nudge refreshes, whether or not it mattered.**~~ Fixed (D-099).
~~**Presence is per-process.**~~ Fixed (D-100).

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
