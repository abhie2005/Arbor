# Status — resume here

Last updated 2026-09-07. Repo: https://github.com/abhie2005/Arbor (`main`).

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
| **Schema** | 43 tables, 9 enums, 116 indexes. Migrated (0000–0004) and seeded. |
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
| **Notification fan-out** | Written inside the transaction that caused them, for direct signals only: assigned, mentioned, replied. Never to someone who cannot open the task, and the inbox filters again on read because access can be revoked afterwards. Rule is pure and in core; **no UI yet**. |

**Verified:** 291 unit tests, 112 live-Postgres checks, 65 server-action checks,
four packages typechecking clean, and the interactions above driven in Chrome.

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

**Phase 7 is most of the way through its second half.** The task detail page
and comments are built, and so is the notification fan-out — the write side.
What remains of notifications is the part people can see; then realtime, then
presence.

The pass ran as commits verified on all four gates before the next started:
shell extraction, authorization, the detail page, comments, fan-out.

### Next — the inbox

The fan-out is done and has 14 live-Postgres checks behind it. `notifications`
has rows in it for the first time. **Nothing displays them**, which is the whole
of the next chunk:

- **`loadInbox`, `unreadCount`, `markRead` and `markAllRead` already exist** in
  `packages/db/src/notifications.ts`, scoped and tested. The page is a consumer,
  not new query work.
- **The sidebar's `Inbox 3` is still a literal `3`** in
  `components/app-shell.tsx`, marked with a comment. `unreadCount` replaces it.
- **`/inbox` needs a route.** It is the first screen not scoped to one
  container, which is already handled in the query — the join is on each row's
  own list rather than on one known in advance.
- Clicking a row should mark it read and open `/t/<key>`.

Then the **read-time aggregation over `activity`** for watchers, which is the
other half of the table's design and has no code yet.

### Background — why notifications are shaped this way

This is the honest next step, and it is where the schema has been waiting.
`notifications` exists and is empty. The comment on the table says what it is
for: **write-time fan-out for direct signals only** — assigned, mentioned,
replied — with ambient activity aggregated at read time from `activity`,
because a task with 200 watchers would otherwise write 200 rows per edit.

Most of what it needs already landed:

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
- **The sidebar's `Inbox 3` is hardcoded.** It is a literal `3` in
  `components/app-shell.tsx`, marked with a comment. That badge and an
  `/inbox` page are the visible half.

**The one thing to decide first** is whether notifications are written inside
the same transaction as the operation that caused them. Inside is correct — a
comment and the fact that it notified someone either both happened or neither
did — and because only direct signals are written, the cost is proportional to
the number of people *named*, which is small. Outside needs something to run it,
and `apps/worker` does not exist. That is the same shape of decision as D-071 (a
rebuild per share), and it should be made deliberately rather than by whichever
is easier to write.

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
