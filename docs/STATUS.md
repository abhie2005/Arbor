# Status — resume here

Last updated 2026-10-14. Repo: https://github.com/abhie2005/Arbor (`main`).

**Phases 1–9 are done. Phase 10 is under way: automations run, and now they
have a screen.** A rule can be written, armed, disabled and deleted by a person
rather than by a smoke test — the conditions are the filter bar's own menus,
because a rule's conditions *are* a `FilterGroup` (D-129). Building it found the
bug below, which is the kind only running the thing finds.

**The automation service account was in no access index, so every rule with a
condition skipped forever in a fresh workspace** (D-129). `ensureAutomationActor`
created the account and its membership and never rebuilt the index; conditions
are evaluated *as the robot* through the compiler, which joins `access_index`,
so they matched nothing and recorded `skipped_conditions` — which reads as the
condition being wrong. Fixed in the transaction that creates the account. Every
check passed while this was broken because the actor survived between smoke
runs and an earlier rebuild had already indexed it; the fixture now deletes it
each run, so the path that creates one is exercised every time.
Phase 9's roadmap line read "CRDT editor, nested pages, backlinks" and all
three now exist: documents are editable *including the paragraphs that name
somebody*, ⌘Z in one is the CRDT's and puts the caret back where the edit was,
search reads them, the page tree is a tree you can rearrange, and `[[` links a
page or a task with the reverse lookup on both ends. The AWS path has been
applied against a real account once and destroyed again.

**`CLAUDE.md` at the repo root is the map** — invariants, where things live,
commands, gotchas. It loads automatically. This file is only *current state and
what is next*, so start here when resuming and do not read the tree to orient
yourself.

**The three bugs that were open are fixed** (2026-10-11), each as its own
commit: the hydration mismatch on every timestamp (D-121), the sharing screen
that listed every container in the workspace (D-123), and mentions that
resolved against every user in the database (D-122). Each one turned out to be
wider than it was written up as, and the extra doors are in the entries.

**Three things were found while fixing them and are deliberately not fixed.**
They are the next small jobs, under "Open bugs" below: a latent copy of the
hydration bug in the four view renderers that **no check in this repo can
reach**, five people-lists that are still workspace-wide, and no fixture
anywhere for a second workspace.

The archaeology of the bugs that are fixed, and what browser verification found
in each phase, is in `docs/HISTORY.md`.

---

## Open bugs

**1. The four view renderers format an instant with no zone — latent, and
unreachable by every check here.** `task-row.tsx`, `task-table.tsx`,
`board.tsx` and `task-detail.tsx` all format due dates through
`dateFrame(hasTime)`, which correctly returns `{}` for an instant — and `{}`
means the ambient zone, which is the server's on the server and the viewer's in
the browser. That is D-121 exactly, in four more places.

It has never shown because **the seed has no task with `dueHasTime: true`**.
Every seeded due date is a calendar day, so only the UTC branch is ever taken,
and the instant branch cannot be exercised by `npm test`, `db:smoke`,
`check:actions` or a browser pass over seeded data. `isOverdue` on the same
path compares against `Date.now()` and has the same shape of problem.

The fix is `Timestamp`'s two renders pushed into those four, which is more
invasive than it sounds — the label comes out of a `formatDue` helper that
returns `{ label, overdue }` and is read inside drag-heavy markup. **Seed one
task with `dueHasTime: true` first**, or the fix cannot be verified either.

**2. Five people-lists are still every user in the database.** `views.ts:420`,
`task.ts:279`, `goals.ts:33`, `dashboards.ts:54` and `column-values.ts:160`
each read `FROM users` with no workspace join, to label an id or fill a picker.
D-122 fixed the two that turn typed text into a *stored* mention and left
these, which only display: an assignee picker offering somebody from another
workspace is a real bug and a smaller one. They want `mentionableIn`, or its
read-only equivalent.

**And they now offer robots.** A workspace's automation account is a real
`users` row (D-126), so it appears in the user switcher, in the assignee and
watcher pickers on a task, and in the automations screen's own target menu —
twice, if the database has been re-seeded, because the account's synthetic
email carries the workspace id. Assigning a task to a service account is not
harmful, it is just not a thing anybody means. Whatever fixes the five lists
should take `kind = 'service'` with it; the decision to make is whether an
automation may ever *name* one deliberately, which is why this is not simply a
`WHERE kind <> 'service'` on every picker.

**3. There is no second workspace anywhere, and that is why both of the above
hide.** All four seeded users are members of the one workspace, so every
cross-workspace question answers correctly by accident. `check:actions` now
makes a non-member user inline for one assertion (D-122) and deletes it again,
which is the narrowest possible version of the fixture. A second seeded
workspace would make a whole class of check expressible, and would probably
find more than the two above.

---

## What works today

| Area | State |
|---|---|
| **Schema** | 45 tables, 10 enums, 126 indexes. Migrated (0000–0015) and seeded. `pg_trgm` is required from 0011 (D-113); 0013–0015 are the automation runtime, its activity kind, and a rule's delay. |
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
| **Automations** | A rule is a trigger, a `FilterGroup` of conditions and actions that compile to operations. Fires from the activity log, runs as a per-workspace service account, claimed with `SKIP LOCKED` (D-124, D-125, D-126). A delay is the rule's and its conditions are asked when it acts (D-128). `/settings/automations` writes one: the container tree scoped to what the viewer may `manage`, the filter bar's own menus for conditions, a one-sentence summary of what each rule does, its last run, and the month's quota. A rule can be disabled or deleted, not yet edited. The drain runs in the server process, started from `/api/health` and the root layout. |
| **Saved views** | The tab strip is the list of saved views. Create, rename, duplicate, set default, delete — validated by compiling the definition before it is written. Personal views are invisible to others. |
| **Filter bar** | On all three renderers. Menus are built from the same declaration the compiler validates against, so an invalid filter cannot be expressed. Filter state lives in the URL and is shareable; a malformed link errors instead of showing everything. |
| **Field types** | All 20 declared in one place: storage column, legal operators, config parser, value parser. |
| **Status sets** | CRUD, inheritance resolution, four templates, reordering, and task migration on delete. |
| **Custom fields** | CRUD, per-type config, placement down the tree, task-type scoping, archive, and type change with a real value migration. |
| **Task types** | CRUD, one default per workspace, deletion with reassignment. |
| **Settings UI** | `/settings` — statuses, custom fields, task types, sharing, automations. |
| **Permissions** | Grants are the source of truth; a pure rule in `@arbor/core` flattens them plus inheritance into the access index every query joins against. Private containers, inherited grants, group grants, role baselines. Rebuilt inside the transaction that changed the grant, so a revocation has no stale window. The index holds a row per **container**, not only per list (D-108), so "may this person manage this space" is the same join as "may they see this task". |
| **Sharing UI** | `/settings/sharing` — the container tree with how many people each one reaches, a private toggle, and share/unshare. Inherited grants are shown with their source and are not removable there. **Sharing is a permission on the container now, not a workspace role** (D-109): a lead holding `manage` on their space can share it while staying a plain member, and an admin can no longer share a private space nobody granted them. Making a container private leaves the actor a `manage` grant, so closing the door does not lock you out. |
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
| **Documents** | `/docs` — a page tree scoped by the same `access_index` join everything else uses, and an editor. The tree is a real walk at any depth (D-119): collapse hides descendants, a drop onto a row makes a page its first child and a drop in the gap below one makes it the next sibling, both as one `afterId`, and the `+` on a row makes a subpage. `[[` links a page or a task — a second embed kind the editor's offset arithmetic absorbed without a change — and `doc_links` answers the reverse, shown as "Linked from" on a page and "Referenced by" on a task, scoped to pages the *viewer* can read (D-120). A document's body is a Yjs CRDT holding the *same block tree* comments and descriptions use (ADR 6, D-110), so a mention is a reference rather than the characters "@Name", and `search_text` beside it is a projection recomputed on every write. The editor is a **contenteditable per paragraph** (D-117) with the change applied as a diff (D-112), so two people typing in one paragraph merge instead of clobbering. A mention is one `EMBED_CHAR` in the string the editor works in, which makes a DOM offset, a caret and a CRDT position the same number — so a paragraph naming somebody is edited rather than shown, `@` offers the workspace's members, and the caret is a Yjs relative position that survives both ⌘Z and somebody else's insert. Updates POST as base64 and arrive as a nudge on the existing stream; the editor answers by pulling the difference rather than re-rendering. Creating, renaming, moving and archiving are configuration writes with an activity row and no ⌘Z (D-111). |
| **Search** | `/search` — the screen that finally reads `docs.search_text`. Two halves, each through the permission path it already had: tasks are `compileViewQuery` with scope `everything` and `filters.search` set (which had existed since the beginning and been set by nothing), pages are `searchDocs` sharing `listDocs`' reachability clause. Matching is `ILIKE`, the same rule the compiler has always used, so one box cannot have two ideas of what matches (D-113); trigram GIN indexes make that affordable. A GET with the query in the URL, so a search is a sendable link — no action, no debounce. Snippets are anchored on the match and the term is marked. |
| **Deployment** | `Dockerfile` (two targets: the app as Next's traced standalone output, and a migrator that runs the same `drizzle-kit migrate` a developer does) and `infra/terraform/` — VPC, RDS Postgres, ECS Fargate behind an ALB, two ECR repositories, one secret. 45 resources, `validate`-clean, **never applied against a real account**. The app needed only `output: "standalone"` and `/api/health` to become deployable, because it reads three environment variables and talks to nothing but Postgres (D-114). The ALB's idle timeout and deregistration delay are set explicitly, because SSE streams are exactly what their defaults kill. |
| **Ambient activity** | The read-time half. What happened on tasks you watch, assembled from `activity` at display time and grouped into one row per task, in one stream with the signals (D-089). Excludes your own actions, anything that already notified you directly, and movement that is not news. Read state is one mark per membership rather than a flag per event (D-088). |

**Verified:** 522 unit tests, 245 live-Postgres checks, 11 search checks, 7
document-action checks, four packages typechecking clean, and the interactions
above driven in Chrome — most recently `[[` resolving to a page and then to a task inside one sentence, the
two edges landing in `doc_links`, and the reverse showing as "Linked from" on
the page and "Referenced by" on the task.

`check:actions` is the gate that does not finish on this machine — the VM's
memory ceiling drops a request around a third of the way through (see the gaps
below). Its **documents** section was run on its own, in its own process, and
all 7 of its checks pass.

---

## What is deliberately not built

- `apps/realtime` and `apps/worker` — **not directories, and the README no
  longer says they are.** The transport question is settled against
  `apps/realtime`: Postgres carries changes (D-090), presence within a process
  (D-092), presence between them (D-100) and document updates (D-112), all on
  one connection per process. A collaborative editor was the last thing that
  might have required a gateway and it did not.
- **`apps/worker` is now a deployment decision rather than a missing piece.**
  The automations it was meant to run do run — the queue is a table and the
  drain is a loop in the web process (D-125). Nothing in the engine knows which
  process drains it, so lifting that loop out later is configuration, not a
  rewrite, and the app still reads three environment variables rather than four.
- `packages/sdk` — also not a directory. Needed once there is an API worth a
  typed client, which is the half of Phase 10 that has nothing built against it.
- Chat and AI. **Automations are built** (D-124 → D-129): the engine, the
  delay, and the screen. Forms and the public API are what is left of Phase 10.
- Derived field types (`formula`, `rollup`, `automatic_progress`) are declared
  and filterable, but nothing computes them yet. Time tracking did **not**
  change this: a tracked total is summed at read time, so the question of
  whether these ever need a worker is still open, and a key result over a filter
  is what will decide it.

---

## Where to pick up

**Phase 9 is complete.** Its roadmap line was "CRDT editor, nested pages,
backlinks" and all three exist: documents are permission-scoped and editable by
more than one person at once including the paragraphs that name somebody, the
page tree is a tree that can be rearranged, and `[[` links a page or a task
with the reverse lookup shown on both ends. Search reads them. What remains is
not a numbered item but the gaps below.

**Phase 10 — automations, forms, public API — is part built.** The engine is
proven against Postgres and **now has a screen**: `/settings/automations` writes
a rule, arms it, disables it and deletes it, shows what each one does in a
sentence, what its last run did, and how much of the month's quota is gone.
**Forms and the public API still have nothing built against them** — see "Where
Phase 10 actually is" below.

The workspaces are `apps/web` and `packages/{core,db,ui}`, and that is all there
has ever been — this file used to claim `packages/sdk` was an empty directory
and `apps/worker` had had nothing to run since Phase 1, and the README repeated
it. Both say the truth now.

Two things that were owed before Phase 9 are done and are why the docs screen
was short rather than long:

- **The container permission** (D-081), closed by D-108 and D-109. The access
  index holds a row per container, sharing is a permission on the container
  rather than a workspace role, and `requireViewAccess` stopped checking a
  space as if it were a list — a bug that had been there since saved views were
  built and was invisible because the seed puts every view on a list.
- ~~**A tracked-time rollup.**~~ Built earlier (D-107).

### What Phase 9 owed, and where each answer is written down

All four are built. Kept as one line each because the reasoning is the
valuable part and it lives in `DECISIONS.md`, not here:

1. **Nothing read `search_text`** → D-113. `/search` reads it; both halves
   match with `ILIKE` so one box cannot have two ideas of what matches.
2. **An editor that could hold a mention** → D-117. A hand-rolled
   contenteditable per paragraph, because every Yjs editor binding binds a
   *fixed* shared type and adopting one would have changed what the CRDT
   contains. A mention is one `EMBED_CHAR`, which makes a DOM offset, a caret
   and a CRDT position the same number.
3. **⌘Z meaning the CRDT rather than the browser** → D-116, and the caret it
   left at the end of the paragraph → D-117, which made the caret a Yjs
   relative position.
4. **A page tree that was only indentation** → D-119. The order is computed
   from the tree, collapse hides descendants, and a drop onto a row or into
   the gap below it is one `afterId`.

And the roadmap word that had no code at all:

5. **Backlinks** → D-120. A link is a second embed kind carrying a target kind
   plus an id; `doc_links` is maintained where `search_text` is and answers
   the reverse question, scoped to pages the *viewer* can read.

### Where Phase 10 actually is

**The three questions this file said to settle are settled, by building them.**
Each is a decision entry, and the reasoning is there rather than here:

1. **In-process or a worker?** → D-125. **A table.** A run due in three days is
   a row with `run_after` three days out, and `automation_runs` *is* the queue
   rather than having one beside it. Nothing in the engine knows which process
   drains it, so lifting it into a worker service later is a deployment
   decision and not a rewrite — and the app still reads three environment
   variables rather than growing a fourth (invariant 14). `desired_count = 2`
   already, so `FOR UPDATE SKIP LOCKED` is not a precaution.
2. **Is an action an `Operation`, and whose undo stack?** → D-124. **Yes, and
   nobody's.** The undo stack lives in the browser and is filled by inverses
   handed back to whoever called; an automation calls nothing, so the question
   answered itself once you look at where the stack is.
3. **What does the API authenticate as?** → D-126. **A service account** — a
   real `users` row with an ordinary membership, so it is a principal every
   existing query already understands and no permission code path was added.
   Answered for automations, which needed it first; the token half is still
   open and is noted below.

**What exists:** `packages/core/src/automations.ts` (pure: the rule, trigger
matching, action compilation, the guards — 37 unit tests),
`packages/db/src/automations.ts` (the scan, the claim, execution, rule CRUD),
and `apps/web/src/server/automation-loop.ts` — **the drain runs in the server
process**, started from `/api/health` and the root layout. Migrations 0013, 0014
and 0015. Twenty-three `db:smoke` checks, verified across consecutive runs.

**Delays work** (D-128): `delaySeconds` on a rule becomes `run_after`, and the
conditions are asked when the run *executes* rather than when it was queued —
which is what "in 3 days, if still open" actually means. Both halves are
checked: still open and it acts, no longer open and it skips.

**It is verified running, not only tested**: arm a rule, make one change, call
nothing, and the run appears — right task, written as the service account,
attributed to the right rule. That verification is what found both bugs in
D-127, and neither was visible to any test in the repo.

**`instrumentation.ts` does not work for this** and D-127 says why at length.
Short version: it is compiled for the edge runtime too, that compilation follows
`@arbor/db` into `pg` into `fs`, and the symptom is every page 500ing with
"Can't resolve 'path'" — which reads like the database being down. Do not move
the loop there.

**The screen exists** (D-129). `/settings/automations`, built out of what was
already there: the sharing screen's container tree scoped by
`reachableContainers(… "manage")`, the filter bar's condition menus extracted
into `filter-conditions.tsx` so a view's filter and a rule's conditions cannot
drift, and `describeRule` in core so the list and the form's preview print the
same sentence. Writing a rule takes `manage` on its container rather than a
workspace role, and the container is read off the rule rather than taken from
the request. Nine `check:actions` checks cover the boundary; it was driven in
Chrome end to end — a rule armed through the form fired and the service account
wrote the comment that was typed into it.

**What does not exist yet, in the order it probably wants doing:**

- **A rule cannot be edited, only deleted and written again.** `createAutomation`,
  `setAutomationEnabled` and `deleteAutomation` are the whole service; there is
  no `updateAutomation`. Renaming is the common case and does not need the rule
  re-validated, which is probably two entry points rather than one.
- **The form offers `to` and not `from`.** `parseAutomationRule` takes both, so
  "when the status stops being Blocked" is expressible and nothing offers it.
  `describeRule` already says it when it is there.
- **`parentTaskId` and a duration control are the two menu gaps.** Both are
  deliberate (D-129): a task picker does not exist, and a milliseconds box is
  labelled as one rather than pretending to be hours. A `duration` `ValueInput`
  means teaching the filter bar about it in the same change.
- **The filter bar still shows a text box for a List, Space or Folder filter.**
  `optionsFor` understands `container` now, but only a screen that has filtered
  containers by permission may supply them — the automations screen does, the
  view pages do not. Fixing it properly means `loadFilterOptions` taking a
  viewer, which is five callers.
- **A run that fails is not retried.** `attempts` is incremented by the claim
  and nothing reads it: a `failed` run stays failed. Deliberate for now —
  retrying a half-applied batch needs a rule about which actions already
  happened, and operations are applied in one transaction so today it is all or
  nothing.
- **Quota is counted and never surfaced.** `MONTHLY_RUN_QUOTA` is 1000 and a
  workspace that reaches it gets `refused_quota` rows and no warning anywhere.
- **No relative dates in actions.** "Due in 3 days" is the obvious next action
  kind; `to` is currently a literal value.
- **Forms and the public API.** Untouched. The API needs tokens belonging to a
  service account, which is where D-126's synthetic-email wart gets revisited.
- **`webhooks` and `templates` are still unread**, as they have been since
  Phase 1.

### Known gaps carried into Phase 10

**Undo in a document (D-116)**

- ~~**The caret lands at the end after an undo.**~~ Closed by D-117, which was
  the item it was handed to. The caret is a Yjs relative position carried on the
  stack item, so an undo returns it to where the edit began and a remote insert
  above it moves it by exactly as much as it inserted. Both verified in Chrome.
- **History does not survive a reload.** The stack lives in memory beside the
  `Y.Doc`. Ordinary for an editor; persisting per-client history into a column
  every client shares is a much bigger idea.
- **No visible affordance.** There is no button and nothing says ⌘Z works here,
  which is the same gap the whole app has — the workspace Undo button is in the
  header and means something else while focus is in a paragraph.
- **The remote case is proven by unit test, not in a browser.** Two real clients
  typing at once was checked in `documents.test.ts`; driving two browsers at one
  document is the harness nobody has built yet.

**Deployment (D-114)**

- ~~**It has never been applied.**~~ **It has now** (2026-10-10). All 45
  resources stood up in a real account, the migrator applied the schema, the
  seed ran, and the app answered `/api/health` with `ok` through the ALB while
  every protected route 307'd to `/login`. Then it was destroyed. Total cost of
  finding out: about fifteen cents. What the first apply caught — none of it
  visible to `validate`, to `plan`, or to any test in this repo:
  - **`sslmode=require` stopped meaning what the note below said it meant**
    (D-118). Current `pg-connection-string` treats it as an alias for
    `verify-full`, so the migrator did not connect weakly, it died on
    `SELF_SIGNED_CERT_IN_CHAIN`. Fixed properly rather than downgraded: both
    image targets ship the Amazon RDS CA bundle now.
  - **`DatabaseOptions.ssl` was dead code** implying
    `rejectUnauthorized: false`, and nothing ever passed it — so the posture
    the docs described was never the posture in force. Removed.
  - **The account is on an AWS Free Plan**, which refuses
    `backup_retention_period = 7` with a `FreeTierRestrictionError` naming the
    retention rather than the plan. `db_backup_retention_days` exists now: 7 by
    default, 0 for a throwaway. Nothing else hit the cap — NAT gateway, ALB and
    Fargate all created normally.
  - **The alpine base has no `/usr/local/share/ca-certificates`**, so the
    bundle needed a `mkdir -p` ahead of it.
- Three things that would have made that first apply end badly were fixed
  before it: a `destroy` used to fail on the protected database and again on
  the registries still holding the pushed images — both *after* the VPC had
  gone — and the final snapshot outlived the database it was taken from.
  `db_deletion_protection`, `db_skip_final_snapshot` and `ecr_force_delete`
  make a throwaway run destroyable. **Proven: the destroy completed cleanly**,
  which is the half of the exercise that would have been easy to skip.
- **The runbook never said what permissions the deploy identity needs.** It
  does now: `PowerUserAccess` plus `infra/terraform/deploy-policy.json`, which
  grants the IAM actions this creates and scopes them to `arbor-*` roles. The
  failure it prevents is the slow one — `iam:CreateRole` denied after the NAT
  gateway already exists.
- **No HTTPS until `certificate_arn` is set**, and `arbor_session` is a bearer
  token in a cookie — over plain HTTP it is readable by anything on the path.
- **`allowed_ingress_cidrs` defaults to the whole internet.**
- ~~**The database connection is encrypted but unverified.**~~ Closed by D-118,
  and the premise was wrong rather than merely incomplete: `require` is an
  alias for `verify-full` in current `pg`, so there was never an
  unverified-but-working state to leave in place — only a broken one.
- **Terraform state is local**, so two operators would race. The S3 backend is
  written and commented out in `versions.tf`.
- **Still no CI.** Nothing builds or pushes the images; `compose.yml` used to
  claim a CI that does not exist, and now says so.
- **No autoscaling**, and no alarms on anything.
- **Migrations are additive-only by assumption.** Running them before the new
  image serves is safe for added tables, columns and indexes. The first
  migration that drops or narrows something needs an expand/contract rule,
  which is a paragraph in the runbook rather than a mechanism.
- **`npm audit` reports 11 vulnerabilities (1 critical) inside the image**,
  inherited from the dependency tree rather than introduced here — but the image
  is the thing that would ship them.

**Search**

- **No stemming and no ranking**, which is what `ILIKE` buys and costs (D-113).
  `run` does not find `running`, and Postgres returns a yes rather than a score.
  The move when this bites is `tsvector` on *both* halves in one change — the
  term is parsed in one place (`parseQuery`) so there is one call site to change.
- **A one- or two-character query still scans.** Trigrams need three characters,
  so the index cannot help `os` — and the screen runs the query anyway rather
  than imposing a minimum, because a two-letter task name is a real thing.
- **Comments and task descriptions are not searched.** Both are block trees with
  no plain-text projection beside them; `docs.search_text` exists because
  somebody decided to maintain one. Doing the same for comments is a schema
  change and a backfill, not a screen.
- **Nothing is paginated.** Each half stops at 25 and the heading says "first
  25" when it did. The compiler supports keyset pagination through `after` and
  the screen does not use it.
- **A task matches on its name only.** The compiler's `filters.search` has always
  been `t.name ILIKE`, though its own doc comment claims "name and description"
  — the comment was aspirational and is now corrected to what the code does.
- **No ⌘K.** The box is in the header and needs a click or a tab; there is no
  keyboard route to it, which is conspicuous in an app whose whole pitch is
  keyboard-driven.
- ~~**The screen's HTTP checks have never run.**~~ Closed: they are
  `npm run check:search`, eleven GETs that run against a dev server, the
  container image or a deployed URL (D-115), and they are proven to fail when
  the private page becomes reachable.

**Documents**

- **Two tabs of the same person do not sync.** The editor ignores nudges whose
  actor is the viewer, which is right for avoiding an echo of your own save and
  wrong for a second tab — the same shape D-098 hit with timers, and the fix is
  the same: the stream already knows who, so the client can distinguish "me
  elsewhere" from "me here".
- **Nothing garbage-collects a document's history.** A CRDT only grows; the
  column is capped at a megabyte (D-111) and the answer when it bites is
  re-encoding a fresh document to drop tombstones, which nothing does yet.
- **No presence and no cursors.** Presence exists on the task page and is not
  wired to documents, which is where it would matter most — two people in one
  paragraph currently discover each other by watching words appear.
- **A document on no container takes the workspace role to edit**, following the
  workspace-wide saved view rule. For a handbook page that is probably wrong,
  and it is the same "blunt in the safe direction" trade D-081 made.
- **No comments on a document**, no templates, no export, no archive screen —
  archived pages are only reachable by asking `listDocs` for them. Links
  between a document and a task are built (D-120); the rest of that list is
  not.
- ~~**A new page is always created at the container root.**~~ Closed by D-119:
  the `+` on a row aims the new-page input at that page, and the container
  picker is disabled while it is aimed, because a subpage inherits its
  parent's container.
- **The editor sends on a 400ms timer** and shows "Saving…" / "Saved" with no
  conflict state, because there is no conflict to show — but a failed push
  leaves the text on screen and the error beside it, and nothing retries.

**The editing surface (D-117)**

- **A mention in a document notifies nobody.** A comment's does: the fan-out
  runs inside the causing transaction and asks before granting access to
  somebody who cannot read the task. A document update is a merge of bytes, so
  there is no operation to hang a fan-out on and nothing reads the embed that
  appeared. This is the largest thing the picker makes possible and does not
  do, and it is a real decision rather than an oversight — "who was newly
  mentioned" means diffing two projections of a CRDT.
- **Backspace at the start of a paragraph does nothing**, and there is no way
  to split one. Each paragraph is its own editing host, which is what makes a
  selection unable to span blocks (and so unable to delete across them); the
  price is that the two keystrokes that join and split paragraphs have no
  meaning yet. `+ Paragraph` and the `×` are still how blocks come and go.
- **The composition path is coded but not driven.** `compositionstart` /
  `compositionend` hold off both reading the DOM and repainting it, which is
  what an IME needs, but nobody has typed Japanese into this editor. The
  failure it guards against — a repaint mid-word abandoning the composition —
  is the kind that only shows up with a real IME.
- **The `@` candidates are loaded with the page.** Somebody who joins the
  workspace while a page is open is not offered until a reload. A picker that
  asked the server per keystroke would be a round trip inside the one
  interaction that has to feel local, so this is the trade rather than an
  omission.
- **Nothing shows the caret of the person editing with you.** The relative
  position that keeps *your* caret still is exactly what a remote cursor would
  be built from, and it is not sent anywhere.

**Found while building this, older than it**

- ~~**The task history's timestamps cause a hydration mismatch.**~~ **Fixed**
  (D-121), and it was three screens rather than one — the inbox and a comment
  header carried the same construct, and a time entry's row and the search
  results carried it through `relative`. The zone turned out not to be missing
  but *implied*, which is why the code read as correct: `toLocaleString` with no
  `timeZone` does read an instant in the viewer's zone, and a server render has
  no viewer. `Timestamp` renders a pinned UTC form before hydration and the
  viewer's own zone and clock after it. A latent fourfold copy on an
  unreachable path is under "Open bugs".

**Two things older than this phase, found while building it — both now fixed**

- ~~**`/settings/sharing` lists every container in the workspace to anybody who
  opens it**~~ **Fixed** (D-123). It was the one read in the app that did not
  join the access index, and the cause was a missing *shape*: there was no
  function for "which containers may this person share", only one for "may they
  share this id". `reachableContainers` is that function. The page also never
  called `requireUser` at all.
- ~~**A comment's mention candidates are every user in the database**~~
  **Fixed** (D-122), and a task description had the same bug — the same
  `parseRichText` call behind a second door. The sharp edge was not the wrong
  mention but the refusal: a resolved stranger is unreachable by definition, so
  the consent flow refused the comment and reported their name back, turning a
  permission boundary into a way to confirm an account exists.

### Done — the decision Phase 9 turned on

It was already made. ADR 4 chose a CRDT for rich text and named Yjs; what it did
not say was what the Yjs document *contains*, and that is the part with no
second chance, because a CRDT keeps history and cannot be migrated the way a
`jsonb` column can. ADR 6 records it: a document is the block tree `richtext.ts`
already describes, in Yjs types, with a mention as an embed carrying the user id
(D-110). The projection back to that tree is what every non-editor reads.

ADR 4's transport paragraph is annotated as superseded rather than deleted. It
said one WebSocket per client; there is no WebSocket, `apps/realtime` does not
exist, and document updates ride the same `pg_notify` and `EventSource` as
everything else (D-090, D-112).

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

### Known gaps from Phase 8, still open

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
  tracked against anything but a task; editing an entry moves its start and holds
  its end; an entry spanning midnight belongs to the day it stopped.
- **A tracked-time total is not filterable or sortable**, only summable:
  `trackedMs` is deliberately absent from `BUILTIN_FILTERABLE` (D-107), so
  "tasks with more than eight hours on them" is one line away and not built.
- **Tracked time still does not roll up the hierarchy.** A subtask's hours do
  not reach its parent; that needs the hierarchy, not the compiler.

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
- ~~**Sharing is a workspace role, and should be a container permission.**~~
  Done (D-108, D-109). `resolveAccess` emits a row per container, the sharing
  actions take `manage` on the one they name, and making a container private
  leaves the actor a grant so closing the door does not lock them out. The
  *screen* was the half left open and is closed too (D-123): `/settings/sharing`
  lists what the viewer may share rather than what exists, and
  `/settings/automations` was built the same way from the start.
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
