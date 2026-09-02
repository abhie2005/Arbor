# Decisions

A running log of every non-obvious choice in this project, and the reasoning
behind it.

**Why this file exists.** Code records *what* was built. Git records *when*.
Neither records *why this and not the obvious alternative* — which is the part
that is genuinely hard to reconstruct six months later, and the part anyone
technical will ask about first.

**How it relates to `docs/decisions/`.** Those are ADRs: formal, one file each,
for the five choices that would be most expensive to reverse. This file is the
complete log — including library picks and small calls that don't warrant an
ADR — and it cross-references them.

**Format.** Each entry states the decision, the alternatives and why they lost,
the trade-off knowingly accepted, and what evidence would make us change our
mind. The last line of each is a one-sentence version for when someone asks in
conversation.

**Convention.** Add an entry in the same PR as the change. If a decision is
later reversed, don't delete it — mark it `Superseded by D-NNN` and leave the
reasoning in place. The reversals are often the most interesting part.

---

## Index

| # | Decision | Area |
|---|---|---|
| [D-001](#d-001) | Build an original product, not a clone | Product |
| [D-002](#d-002) | Dense, dark-first, keyboard-driven | Product |
| [D-003](#d-003) | AGPL-3.0 for the server, Apache-2.0 for the SDK | Project |
| [D-004](#d-004) | npm workspaces, not pnpm | Tooling |
| [D-005](#d-005) | Turborepo for task orchestration | Tooling |
| [D-006](#d-006) | Postgres | Data |
| [D-007](#d-007) | Drizzle, not Prisma | Data |
| [D-008](#d-008) | One polymorphic container tree | Data |
| [D-009](#d-009) | Tasks and subtasks share one table | Data |
| [D-010](#d-010) | `task_lists` join table from the first migration | Data |
| [D-011](#d-011) | Denormalized ancestor ids on tasks | Data |
| [D-012](#d-012) | Fractional indices for ordering | Data |
| [D-013](#d-013) | Typed EAV for custom field values | Data |
| [D-014](#d-014) | Statuses carry a group; the group is what code reads | Data |
| [D-015](#d-015) | Soft delete everywhere | Data |
| [D-016](#d-016) | Append-only activity log as the system spine | Data |
| [D-017](#d-017) | One view definition, one compiler, many renderers | Query |
| [D-018](#d-018) | The compiler emits SQL text, not query-builder chains | Query |
| [D-019](#d-019) | Materialized access index instead of walking the tree | Query |
| [D-020](#d-020) | No `SELECT DISTINCT` | Query |
| [D-021](#d-021) | `= ANY($1)` instead of an expanded `IN` list | Query |
| [D-022](#d-022) | Keyset pagination, never `OFFSET` | Query |
| [D-023](#d-023) | Server authority for records, CRDT only for documents | Architecture |
| [D-024](#d-024) | ECS Fargate, not Lambda | Infra |
| [D-025](#d-025) | Own the user table; never make Cognito the identity store | Infra |
| [D-026](#d-026) | S3 API only, never S3-specific features | Infra |
| [D-027](#d-027) | Terraform, not CDK | Infra |
| [D-028](#d-028) | IBM Plex Sans and Mono | Frontend |
| [D-029](#d-029) | Brass accent on cool near-black | Frontend |
| [D-030](#d-030) | 21st.dev registry primitives, re-tokenized on import | Frontend |
| [D-031](#d-031) | Detail panel is a route, not a modal | Frontend |
| [D-032](#d-032) | The demo page has no query of its own | Testing |
| [D-033](#d-033) | A live-Postgres smoke check alongside unit tests | Testing |
| [D-034](#d-034) | Dev-mode user switcher before real auth | Auth |
| [D-035](#d-035) | The mutation executor lives in the data layer, not the web app | Architecture |
| [D-036](#d-036) | The server decides what an operation's inverse is | Architecture |
| [D-037](#d-037) | Find the root `.env` by walking up, and never fall back to a default URL | Tooling |
| [D-038](#d-038) | The undo stack lives at module scope, not in React state | Frontend |
| [D-039](#d-039) | Every keyboard shortcut needs a visible equivalent | Frontend |
| [D-040](#d-040) | Server actions run inside a transition and are always awaited | Frontend |
| [D-041](#d-041) | One declaration table for field types, validated by hand | Data |
| [D-042](#d-042) | The field decides its column; the compiler requires a catalog | Query |
| [D-043](#d-043) | Deleting a status is a task migration, not a delete | Data |
| [D-044](#d-044) | Configuration changes are in the same activity log as tasks | Architecture |
| [D-045](#d-045) | Changing a field's type is a data migration with a confirmation | Data |
| [D-046](#d-046) | Fields accumulate down the tree; status sets override | Data |
| [D-047](#d-047) | Configuration actions return failures, they do not throw | Frontend |
| [D-048](#d-048) | A check that drives server actions over HTTP | Testing |

---

## Product

### D-001
**Build an original product, not a clone** · 2026-08-29 · active

Researched ClickUp's architecture in depth, then built our own product from the
patterns rather than reproducing its interface.

**Alternatives.** A literal clone would be faster to spec but has no reason to
exist, can't be positioned, and creates trademark exposure the moment it's
public.

**Trade-off.** We give up name recognition and have to explain what the product
is from scratch.

**What's protected vs. what isn't.** Functionality and architecture are not
anyone's property — hierarchies, saved views, and custom fields are industry
patterns. Names, logos, icon sets, brand colors, and verbatim UI copy are. We
reimplement the former and share none of the latter.

*In one sentence:* I studied how the category works architecturally, then built
an original product on those patterns rather than copying an interface.

### D-002
**Dense, dark-first, keyboard-driven** · 2026-08-30 · active

31px rows, command palette as primary navigation, near-zero chrome.

**Alternatives.** *Airy and approachable* is what most tools in this category
look like — lower intimidation, but it's the crowded position and it wastes
vertical space. *Editorial and structural* was distinctive but harder to sustain
across hundreds of screens.

**Why density is the wedge.** The dominant complaint about incumbents in this
category is bloat and slowness. Four excellent views that load instantly beat
fifteen that don't, and density is a claim you can verify in one screenshot.

**Trade-off.** Higher bar on typography, contrast, and hit targets — dense UI is
unforgiving of sloppy spacing, and it needs real work to stay accessible.

*In one sentence:* I picked the position the incumbents can't easily take,
because their whole problem is that they're bloated.

---

## Project

### D-003
**AGPL-3.0 for the server, Apache-2.0 for the SDK** · 2026-08-30 · active

**Alternatives.** *MIT* maximizes adoption but lets a larger company run a
closed hosted version of the work. *BSL/source-available* isn't open source and
loses the community benefit.

**Why the split.** AGPL on the server preserves the option of selling hosting
later. A permissive SDK matters because anyone embedding a client shouldn't
inherit copyleft — that would suppress integrations, which are pure upside.

**Trade-off.** AGPL scares off some corporate contributors and some adopters
outright.

**Decide early, not later.** Relicensing after outside contributions arrive
means tracking down every contributor. DCO sign-off from the first PR for the
same reason.

*In one sentence:* AGPL keeps it genuinely open while making it impractical to
strip-mine, and the permissive SDK keeps integrations frictionless.

---

## Tooling

### D-004
**npm workspaces, not pnpm** · 2026-08-30 · active

**Context.** pnpm is the better monorepo package manager — strict dependency
resolution catches phantom dependencies that npm silently allows.

**Why npm anyway.** pnpm wasn't installed on the dev machine and corepack has
been removed from recent Node distributions, so adopting it means every
contributor runs an extra install step before the quickstart works. For a
project whose first impression is `git clone && npm install`, that friction costs
more than strict resolution buys.

**Trade-off accepted.** Phantom dependencies are possible — a package can import
something it doesn't declare, because npm hoists everything to the root. Already
bit us once: `packages/db` imported `@arbor/core` and worked before it was
declared. Mitigation is `npm run typecheck` per package in CI.

**What would change this.** If phantom-dependency bugs recur, or the repo grows
past ~10 packages, switch to pnpm and accept the install step.

*In one sentence:* npm workspaces because the quickstart has to work with zero
setup, and I'd rather pay for that with CI checks than with contributor friction.

### D-005
**Turborepo for task orchestration** · 2026-08-30 · active

**Alternatives.** *Nx* is more powerful and considerably heavier. *Plain npm
scripts* don't cache or parallelize, which shows the moment there are three apps
and four packages.

**Why.** Task-level caching and dependency-aware ordering with about 20 lines of
config. `globalEnv` also documents every environment variable the system reads,
which turned out to be useful documentation in its own right.

*In one sentence:* cheapest possible build orchestration that still caches and
respects the dependency graph.

---

## Data model

### D-006
**Postgres** · 2026-08-30 · active

**Alternatives.** *MySQL* lacks the JSON ergonomics and has weaker index options
for this shape. *MongoDB* would make the hierarchy easy and every permission
query and aggregate hard. *SQLite* can't serve concurrent writers.

**Why.** This workload needs recursive CTEs (container trees), JSONB with GIN
(view definitions, field configs), partial and composite indexes (the access
index and typed EAV), and real transactions. Postgres is the only mainstream
option strong on all four. `pgvector` is enabled from the start for eventual
semantic search — free while unused.

*In one sentence:* the workload is relational with a tree in it, which is
exactly Postgres's strength.

### D-007
**Drizzle, not Prisma** · 2026-08-30 · active

**Alternatives.** *Prisma* has better DX and a nicer schema language, but its
generated client fights hand-written SQL, and its query engine was historically
a separate binary. *Raw pg with hand-written SQL* gives total control and no
type safety on the schema. *Kysely* is excellent but has no migration story.

**Why Drizzle.** The view compiler emits raw parameterized SQL by design (D-018).
The ORM's job here is schema definition, migrations, and typed reads for
straightforward queries — and then to *get out of the way* when we write SQL by
hand. Drizzle does that; Prisma resists it. Schema-as-TypeScript also means the
column comments explaining *why* a column exists live next to the column.

**Trade-off.** Smaller ecosystem, and its relational-query API is younger than
Prisma's.

*In one sentence:* the hard queries are hand-written SQL, so I wanted an ORM
that doesn't fight that — Drizzle is a thin typed layer, Prisma is a framework.

### D-008
**One polymorphic container tree** · 2026-08-30 · active · [ADR 1](docs/decisions/0001-one-container-tree.md)

`containers` holds spaces, folders, and lists in one self-referencing table with
unconstrained depth.

**Alternatives.** *Three tables* is the obvious model and is what the incumbents
did — and every one of them later had to ship "subfolders" as a schema
migration.

**What breaks the three-table model.** A list can sit directly in a space with
no folder, so you get a nullable folder id plus a second code path for every
query. And each new nesting level is another table.

**Trade-off.** `kind` must be validated in the service layer — the database
won't stop a list from containing a folder. Recursive queries need care, which
D-011 handles.

*In one sentence:* modelling the hierarchy as one tree instead of three tables
means arbitrary nesting depth is free, rather than a migration later.

### D-009
**Tasks and subtasks share one table** · 2026-08-30 · active

A subtask is a task with a `parent_task_id`.

**Alternatives.** A separate `subtasks` table means every feature — assignees,
comments, custom fields, time tracking, filters — gets built twice, and
"promote subtask to task" becomes a cross-table migration instead of setting a
column to null.

**Trade-off.** Every query must decide whether it means top-level tasks or all
tasks. Handled explicitly in the view definition via `showSubtasks: 1|2|3`.

*In one sentence:* subtasks are tasks, so they're the same row — otherwise you
build the entire product twice.

### D-010
**`task_lists` join table from the first migration** · 2026-08-30 · active

A task has one home list (which owns its status and custom fields) but can
appear in many.

**Why now rather than when the feature is needed.** This is the single decision
that most cheaply prevents a rewrite. `tasks.list_id` is the natural first
schema; the moment multi-list membership is required, every task query in the
application has to change. Adding an unused join table costs one migration.

**Trade-off.** Two sources of truth for placement — `home_list_id` and the join
rows — which must be kept consistent. The seed deliberately writes both so every
query path is exercised.

*In one sentence:* the join table was free to add on day one and would have been
a full-application rewrite to add on day one hundred.

### D-011
**Denormalized ancestor ids on tasks** · 2026-08-30 · active

`tasks.space_id` and `tasks.folder_id`, maintained on move.

**Alternatives.** A recursive CTE per query is correct and slow. A closure table
is a third structure to keep consistent.

**Why.** With D-008's unconstrained depth, "every task in this space" would
otherwise recurse. Two denormalized columns turn it into an index scan. This is
what makes arbitrary nesting depth affordable.

**Trade-off.** They must be recomputed whenever a task or one of its containers
moves. `denormalizedAncestors()` in `@arbor/core` is the single place that
computes them, and it's unit-tested.

*In one sentence:* I traded a small write-time cost for making every
cross-container read an index scan instead of a recursive query.

### D-012
**Fractional indices for ordering** · 2026-08-30 · active · [ADR 2](docs/decisions/0002-fractional-indexing.md)

Positions are strings that sort lexicographically, not integers.

**Alternatives.** *Integer positions*: dropping a task at the top of a 500-row
list rewrites 500 rows — and in a real-time product each is a broadcast to every
connected client. *Gapped integers* (100, 200, 300) postpone the problem and
still require periodic renumbering.

**Why a library.** `fractional-indexing` (MIT, ~200 lines) rather than
hand-rolling. The midpoint algorithm with integer-part carry is subtle, and a
bug corrupts ordering *silently* — the worst failure mode. `ordering.ts` wraps it
in domain language (`positionBetween`, `positionForMove`).

**Trade-off.** Strings grow under repeated insertion at the same point.
`needsRebalance()` flags a collection past 48 characters for a background
rewrite. Verified with a 200-iteration same-gap insertion test.

*In one sentence:* a drag writes one row instead of five hundred, and concurrent
drags converge instead of fighting.

### D-013
**Typed EAV for custom field values** · 2026-08-30 · active · [ADR 5](docs/decisions/0005-typed-eav-for-custom-fields.md)

`field_values` with `value_text`, `value_num`, `value_date`, `value_bool`,
`value_json`, indexed per column.

**Alternatives.**

| Option | Why not |
|---|---|
| JSONB blob on `tasks` | Fastest to ship. Hits a wall the first time someone sorts a view by a custom number field across 100k tasks — GIN doesn't help range queries or ordering. |
| A physical column per field | Fastest reads, and unworkable: runtime DDL, per-tenant schema drift, migration hell. |

**Trade-off.** One row per (task, field) — wider than a blob, and each filtered
field costs an `EXISTS` subquery.

**Sharp edge found while building.** The compiler picks the value column from the
JavaScript type of the filter value, so a number filter against a text field
silently matches nothing. Needs validation of field type against filter value at
the API boundary — not yet implemented, tracked.

*In one sentence:* typed columns keep filtering and sorting on an index, which
JSONB can't do and runtime DDL can't survive.

### D-014
**Statuses carry a group; the group is what code reads** · 2026-08-30 · active

Users name statuses freely; every status belongs to `not_started`, `active`,
`done`, or `closed`.

**Why.** Without this, "is this task finished?" is unanswerable across a
workspace — one team's done column is called "Shipped", another's is "Live".
Reporting, burndown, completion percentages, and the default "hide closed"
filter all key off the group.

**Trade-off.** Users can't invent a fifth group, which occasionally frustrates
someone. That constraint is what keeps cross-workspace reporting possible.

*In one sentence:* free-form status names with a fixed underlying taxonomy, so
customization doesn't destroy reporting.

### D-015
**Soft delete everywhere** · 2026-08-30 · active

`archived_at` and `deleted_at` on every user-facing entity; nothing is hard
deleted.

**Why.** Users of this class of tool delete things by accident constantly.
"Restore" is table stakes, and it's very hard to add later because the rows are
gone.

**Trade-off.** Every query must filter them out — a forgotten `deleted_at IS
NULL` is now a class of bug. Centralized in the view compiler, which is why the
compiler is the only way to read tasks.

*In one sentence:* deletes are reversible by default, and the compiler enforces
the filter so nobody forgets it.

### D-016
**Append-only activity log as the system spine** · 2026-08-30 · active

One row per field change in `activity`.

**Why it's infrastructure, not a feature.** Task history, the activity feed,
notification fan-out, automation triggers, "time in status" reporting, and
derived-field invalidation are all *readers* of this one table. Building them
independently means six systems that each need to know when something changed.

**Design detail that matters.** `actor_id` is null for automation-driven
changes, with `automation_id` set instead. Attributing a robot's edit to the
user who tripped it makes the history lie — and history is the one thing this
table exists to provide.

**Trade-off.** Write amplification: a bulk edit of 200 tasks writes 200 activity
rows. Acceptable, and `bigserial` is sized for it.

*In one sentence:* one append-only log that notifications, automations, history,
and reporting all read from, instead of six systems each detecting change.

---

## Query layer

### D-017
**One view definition, one compiler, many renderers** · 2026-08-30 · active

Every view type — list, board, calendar, gantt — serializes to the same JSON
object: `grouping`, `sort`, `filters`, `columns`, `settings`.

**The insight.** A board is `grouping.field = "status"`. A calendar is a date
field on an axis. A table is a list with every column shown. They are not
different features; they are different renderers over one query.

**Why it's the core of the product.** Shipping a board view is a weekend.
Shipping a system where any user can define grouping, filters, sort, and visible
columns against arbitrary user-defined fields, save it, and share it — that's
the actual work, and every subsequent view type costs days instead of weeks.

**Trade-off.** The definition object is untrusted input from the client, so the
compiler must treat every field reference as hostile (D-018).

*In one sentence:* views are saved queries plus a renderer, so I wrote the query
compiler once and each new view type is now a rendering problem.

### D-018
**The compiler emits SQL text, not query-builder chains** · 2026-08-30 · active

`compileViewQuery()` returns `{ text, params }`.

**Alternatives.** Returning a Drizzle query object would be more ergonomic — and
would make `@arbor/core` depend on the database package, on Drizzle's version,
and on a live connection to test.

**Why.** `packages/core` has no database handle and no request object. The
compiler's entire test suite runs in 5ms with no Postgres. That's what makes the
hardest part of the system also the easiest part for a stranger to contribute to.
`executeCompiled()` in `@arbor/db` is the single seam where text meets a
connection.

**Trade-off.** No compile-time guarantee the SQL is valid — which is exactly what
bit us in D-020, and why D-033 exists.

**Security consequence.** Because we build SQL text, injection is a real risk.
Two rules: field references resolve through a closed map (anything not in
`BUILTIN_SQL` throws), and every value is a bound parameter. Custom field ids
are validated against a UUID regex before they can reach a query. Both are
directly unit-tested with hostile input.

*In one sentence:* keeping the compiler free of any database dependency makes it
trivially testable, at the cost of needing a live check for SQL validity.

### D-019
**Materialized access index instead of walking the tree** · 2026-08-30 · active · [ADR 3](docs/decisions/0003-materialized-access-index.md)

`grants` is the source of truth; a background job flattens grants plus
inheritance into `access_index (principal_id, list_id, permission)`.

**Why.** Any container can be private, access inherits downward and can be
tightened at any level. Resolving that by walking parents costs one join per
nesting level, on every view query, for every viewer.

**The join is first, deliberately.** It's the most selective predicate, and
putting permission in the query plan rather than in a post-processing pass makes
it structurally impossible to leak a private list by forgetting a check.

**Nice consequence.** The "Everything" view needs no scope predicate at all —
the access index already defines what "everything" means for that viewer.

**Trade-off.** Eventually consistent. A revoked grant remains visible until the
rebuild completes; revocations that must be immediate need a direct delete.

*In one sentence:* permissions are precomputed into a join table, so every query
gets permission filtering for the price of one index lookup instead of seven.

### D-020
**No `SELECT DISTINCT`** · 2026-08-30 · active

**How this came up.** The first compiler emitted `SELECT DISTINCT`, defensively.
Unit tests passed. The first run against real Postgres failed:
`for SELECT DISTINCT, ORDER BY expressions must appear in select list` — which
broke every view sorted by a custom field, since that sort is a correlated
subquery.

**The fix was to remove it, not to work around it.** No join in the query can
multiply rows: `access_index` is keyed on (principal, list), `statuses` on its
primary key, and every multi-value filter is an `EXISTS` subquery rather than a
join — specifically so rows stay unique. `DISTINCT` was doing nothing except
adding a sort over the whole result set and forbidding a legitimate `ORDER BY`.

**Lesson recorded.** Defensive `DISTINCT` is a smell: it means you don't know
your join cardinality. Now covered by a regression test that asserts the string
never appears.

*In one sentence:* I'd added DISTINCT defensively, it silently broke sorting by
custom fields, and removing it was correct because the query is unique by
construction.

### D-021
**`= ANY($1)` instead of an expanded `IN` list** · 2026-08-30 · active

`IN` filters compile to `t.priority = ANY($1)` with the array as one parameter,
rather than `IN ($1, $2, $3)`.

**Why.** The query text is then identical regardless of how many values the user
selected. Postgres's prepared-statement cache is keyed on the text, so filtering
by 2 statuses and by 7 statuses reuse the same plan instead of producing a new
entry each time. Directly asserted in a unit test.

*In one sentence:* one parameter instead of N keeps the query text stable, so
the prepared-statement cache actually gets hits.

### D-022
**Keyset pagination, never `OFFSET`** · 2026-08-30 · active

Ordering always ends with `t.id ASC` as a stable tiebreaker.

**Why.** `OFFSET 10000` makes Postgres produce and discard 10,000 rows. Users of
a board view scroll deep inside a single column, so this is a real path, not a
theoretical one. It's also *incorrect* under concurrent writes — a task inserted
above your position shifts everything and you see a row twice.

**Trade-off.** No random page access. Acceptable: the UI is infinite scroll, not
numbered pages.

*In one sentence:* OFFSET is both slow and wrong when rows are being inserted
concurrently, which in a real-time product they always are.

---

## Architecture

### D-023
**Server authority for records, CRDT only for documents** · 2026-08-30 · active · [ADR 4](docs/decisions/0004-no-crdt-for-records.md)

Two sync strategies, deliberately.

**Records** (tasks, fields, statuses): server-authoritative. Client writes
optimistically to a local cache, server validates and broadcasts a delta.

**Rich text and canvas** (docs, whiteboards, descriptions): Yjs CRDT.

**Why not CRDTs for everything.** It's the tempting unification and it's wrong.
Conflicts on structured records are rare and per-field; last-write-wins is fine.
More importantly, a CRDT makes server-side validation impossible — "you may not
move this task to a status you can't see" becomes unenforceable when the client
is authoritative. You'd pay enormous complexity to lose your validation layer.

**Trade-off.** Two sync paths to maintain, and the boundary has to stay crisp.

*In one sentence:* CRDTs solve concurrent text editing, and using them for task
records would mean paying that complexity to give up server-side validation.

---

## Infrastructure

### D-024
**ECS Fargate, not Lambda** · 2026-08-30 · active

**Why.** WebSockets need long-lived connections. API Gateway's WebSocket API
turns every message into an invocation, which is both awkward and expensive at
collaboration volume. Fargate also runs the same container image locally, so
dev/prod parity is free.

**Three services, not one:** `web`, `realtime`, `worker`. They scale on
completely different signals — request rate, concurrent connections, queue
depth. One container for all three means paying the worst case of each.

**Trade-off.** No scale-to-zero; there's a always-on baseline cost.

*In one sentence:* real-time collaboration needs persistent connections, which
is the one workload serverless functions are genuinely bad at.

### D-025
**Own the user table; never make Cognito the identity store** · 2026-08-30 · active

Sessions, invites, and roles are rows in our Postgres. Cognito, Okta, and Google
Workspace federate on top as optional SSO.

**Why.** If login requires an AWS account, nobody can self-host — which forfeits
most of the point of open-sourcing the project. Cognito is also genuinely
awkward to work with and can't run locally.

**Trade-off.** We own password hashing, session rotation, and reset flows —
security-sensitive code. Mitigated by using well-trodden primitives (argon2id,
hashed session tokens) and keeping the surface small.

*In one sentence:* a self-hoster has to be able to log in without an AWS account,
so identity lives in our own tables and cloud providers are optional on top.

### D-026
**S3 API only, never S3-specific features** · 2026-08-30 · active

Storage code uses the S3 API surface, so MinIO, S3, R2, and Backblaze are
interchangeable. Attachments store an object key, never a full URL — the host
varies per deployment.

**Trade-off.** No S3-only features (Object Lambda, S3 Select). None are needed.

*In one sentence:* one API surface means the same code runs against MinIO locally
and S3 in production, with only a connection string changing.

### D-027
**Terraform, not CDK** · 2026-08-30 · active

**Alternatives.** *CDK* is nicer in a TypeScript monorepo and would share types
with the app.

**Why Terraform.** This is a public repo. More contributors can read HCL than can
read CDK's synthesized abstractions, and Terraform ports to other clouds — which
matters given D-026's portability commitment. Shipped as a module people can
`terraform apply` into their own account.

*In one sentence:* for a public repo, infrastructure code should be readable by
the most people, and that's Terraform.

---

## Frontend

### D-028
**IBM Plex Sans and Mono** · 2026-08-30 · active

**Alternatives.** *Inter* is the safe default and is everywhere. *Geist* is
excellent but I wasn't certain of its Google Fonts availability, and a silent
font fallback is a bug you don't notice.

**Why Plex.** It's a genuine superfamily, so the sans and mono share proportions
and never look pasted together — which matters when every row is stamped with
`ENG-402`. Its mono has excellent digit and hyphen clarity at 10px. And it's
OFL-licensed, so an open-source project ships it without an asset-licensing
footnote.

*In one sentence:* a real superfamily so the mono and sans match, with digits
legible at 10px, under a license we can ship.

### D-029
**Brass accent on cool near-black** · 2026-08-30 · active

`#E9A23B` on `#0C0F14`.

**Why.** The warm/cool tension is the identity: everything structural is a
desaturated blue-grey, and the one warm hue marks what is *yours* — focus,
selection, active nav, primary action. Deliberately not the indigo-on-charcoal
that every tool in this category defaults to.

**Semantic color is separate from the accent.** Status groups (grey/blue/green)
and priority (red/amber/blue/grey) are their own scales. If the accent doubled
as "active", it would stop meaning "here".

**Accessibility detail.** Status and priority pair color with *shape* — filled
vs hollow dot, flag vs dash — so the UI survives colorblindness and greyscale.

*In one sentence:* one warm accent against cool neutrals, reserved strictly for
interaction state, with semantic color kept on separate scales.

### D-030
**21st.dev registry primitives, re-tokenized on import** · 2026-08-30 · active

Interaction primitives (cmdk, popover, dialog, date picker) come from the
registry via the shadcn CLI into `packages/ui/src/primitives/`.

**Why the registry model fits.** Code is copied into the repo rather than
imported as a dependency — so contributors can edit every pixel, there's no
version lock, and no upstream release can break the app. Radix underneath means
focus trapping, roving tabindex, and ARIA are already correct, which is most of
the accessibility work in a keyboard-first product.

**The discipline that matters.** shadcn defaults are built for comfortable
density: `h-10` controls, `rounded-lg`. Our target is a 31px row and a 4px
radius. Every import is re-tokenized *centrally* in `tokens.css`, not per usage
site — otherwise density drifts component by component until it looks like every
other shadcn project.

**Licensing.** Registry components are community-published under their own
licenses. Every import is recorded in `packages/ui/ATTRIBUTIONS.md`. In an AGPL
repo this isn't bookkeeping — an unattributable component is one a downstream
adopter can't safely ship.

*In one sentence:* the registry gives us Radix-quality accessibility as editable
source in our own repo, provided we re-skin it centrally and track provenance.

### D-031
**Detail panel is a route, not a modal** · 2026-08-30 · planned

Opening a task pushes `/t/ENG-402` while the list stays mounted behind it.

**Why.** Browser back closes the panel, the URL is shareable, and the list never
re-fetches. A modal gets none of those and has to reimplement all three badly.

**Why decide it now.** Panel-as-route vs panel-as-modal touches every screen
afterwards.

*In one sentence:* making the detail panel a route means back, deep links, and
cached list state all work for free.

---

## Testing

### D-032
**The demo page has no query of its own** · 2026-08-30 · active

`apps/web` renders through `compileViewQuery()` rather than a hand-written
query.

**Why.** It couples the screen to the compiler on purpose: if the compiler
breaks, the screen visibly breaks. The alternative — a convenient bespoke query
for the demo — would let the compiler rot silently while the UI kept working.

*In one sentence:* the UI is a consumer of the same compiler the API uses, so
there's no path where the demo works and the real query layer doesn't.

### D-033
**A live-Postgres smoke check alongside unit tests** · 2026-08-30 · active

`npm run db:smoke` runs compiled queries against a seeded database.

**Why it exists.** Because D-018 means the compiler produces SQL *text*, unit
tests can only assert on strings. They can't tell you the SQL doesn't parse.
D-020 is the proof: 25 unit tests passed on SQL Postgres rejected outright.

**What it asserts beyond "it runs."** That a user with no access rows gets zero
rows — permission scoping verified behaviorally rather than by grepping the query
for a join.

**Trade-off.** Requires a running Postgres, so it can't be part of `npm test`.
Run in CI as a separate job.

*In one sentence:* string assertions can't catch invalid SQL, so there's a
second suite that runs the generated queries against a real database.

---

## Auth

### D-034
**Dev-mode user switcher before real auth** · 2026-08-30 · active

A header that selects among seeded users, gated behind `NODE_ENV !== production`.

**Why.** Every mutation needs an actor, and the activity log is worthless without
one — but email/password auth is well-understood, unsurprising work that isn't
where this project's risk lives. The switcher unblocks the mutation layer and the
interactive list today; real auth lands in Phase 5 with permissions, where it
belongs.

**The rule that keeps this safe.** Application code only ever calls
`getCurrentUser()`. The switcher is one implementation behind that function, so
swapping it for real sessions changes one file. If any component reads the
switcher directly, this decision has leaked and needs fixing.

**Hard gate.** The switcher must refuse to work when `NODE_ENV === "production"`
— a dev auth bypass that ships is a critical vulnerability, and "we'll remember
to remove it" is not a control.

**What would change this.** Anything user-facing being deployed publicly, at
which point real auth stops being deferrable.

*In one sentence:* I stubbed identity behind a single interface so the
interesting work — mutations and the activity log — wasn't blocked on
undifferentiated auth plumbing.

### D-035
**The mutation executor lives in the data layer, not the web app** · 2026-08-30 · active

`applyOperations` sits in `@arbor/db`, takes an `actorId` parameter, and knows
nothing about sessions.

**How this came up.** It was written in `apps/web/src/server/` with a
`server-only` import and an internal `requireUser()` call. That made it
impossible to exercise outside a Next.js request — which is how I noticed the
real problem: **the worker needs to apply operations too.** Running an
automation action *is* applying an operation. So does an API client, and so will
an importer.

**The fix.** Move it down a layer and invert the dependency on identity: the
caller supplies the actor, because the caller is the one who has it. The web app
gets it from a session, the worker from the automation record.

**What this bought immediately.** The mutation path became testable from a
script, which is how the eight mutation checks in `db:smoke` exist at all —
activity-row counts, undo round-tripping, no-op suppression, and the
`completed_at` derivation are all verified against real Postgres now.

**The tell to watch for.** Code that can only run inside a request usually
belongs to the request. When it can't be tested without one, that's the signal
it's in the wrong layer.

*In one sentence:* the executor was trapped in the web app because it fetched
its own identity, and moving it into the data layer with the actor passed in made
it reusable by the worker and testable in isolation.

### D-036
**The server decides what an operation's inverse is** · 2026-08-30 · active

Each server action returns the inverse operations; the client stores them and
decides only *when* to apply them.

**Alternative.** Have the client construct the inverse from what it has on
screen. Simpler, and wrong: a tab that's been open for ten minutes has a stale
idea of `from`. Undoing would restore a value that was never there, silently
overwriting someone else's change.

**Why this split.** The server knows the previous value at the moment of the
write. The client knows the user's intent to undo. Each side decides the thing
it actually has information about.

**Trade-off.** Inverse operations travel over the wire, so the payload is
slightly larger and the undo stack holds server-shaped data.

*In one sentence:* only the server knows what the value actually was, so it
computes the inverse and the client only chooses when to apply it.

### D-037
**Find the root `.env` by walking up, and never fall back to a default URL** · 2026-09-01 · active

`packages/db/src/env.ts` searches upward from `process.cwd()` for a `.env` and
loads it with `override: false`.

**How this came up.** The user followed the README exactly — `cp .env.example
.env` at the repo root — started the dev server, and got "Could not reach the
database. DATABASE_URL is not set." In a workspace the `.env` lives at the root,
but Next.js only reads its own app directory, and `npm run db:seed` starts in
`packages/db`. Neither ever saw the file.

**Why I hadn't caught it.** Every time I tested, I passed `DATABASE_URL=...`
inline on the command line. That masked the bug completely — the code worked
under my invocation and failed under the documented one. **A verification that
doesn't use the documented path isn't verification.**

**Alternatives.** *A `.env` copy per app* means several files drifting out of
sync, and the secret exists in more places. *Requiring an inline variable* makes
the quickstart worse for exactly the people the quickstart exists for.
*Turbo's `globalEnv`* passes variables through but does not load the file.

**`override: false` matters.** An inline variable and real production
environment variables must always beat the file, or a stray `.env` on a server
silently redirects the app.

**The related fix.** `drizzle.config.ts` had a hardcoded
`?? "postgres://arbor:arbor@localhost:5432/arbor"` fallback. Removed — a silent
default to localhost is how a migration gets run against the wrong database:
it succeeds locally, does nothing in production, and raises no error.

*In one sentence:* the env file sits at the workspace root but processes start
in subdirectories, so the loader walks up to find it — and I removed the
hardcoded database fallback, because a silent default is worse than a crash.

### D-038
**The undo stack lives at module scope, not in React state** · 2026-09-01 · active

`apps/web/src/components/undo-store.ts` owns the stack; the provider subscribes
to it with `useSyncExternalStore`.

**How this came up.** The user reported that ⌘Z did nothing, while every other
interaction worked. Since clicking a status dot succeeded, the server had
returned the inverse and `record()` had run — so the stack should have had
content by the time the key was pressed.

**The cause.** The stack was held in a `useRef` inside `UndoProvider`. Every
mutation ends with `revalidatePath("/")`, which re-renders the page; when that
remounts the provider, the ref is re-initialised to a fresh empty stack. The
history was being wiped moments after being recorded.

**The fix, and why it is not a workaround.** Undo history belongs to the
*session*, not to a component instance. Module scope is what "the session"
means on the client: it survives every remount and clears only on a full page
load. Putting it there is the correct home, and it happens to be immune to the
remount question entirely.

**The general lesson.** State whose lifetime is longer than any component's
should not live inside a component. If a remount would lose it and that loss
would be a bug, it is in the wrong place.

*In one sentence:* undo history outlives any single render, so holding it in a
ref meant a revalidation could silently erase it — module scope matches its
actual lifetime.

### D-039
**Every keyboard shortcut needs a visible equivalent** · 2026-09-01 · active

Undo is now a button in the header showing the stack depth, as well as ⌘Z.

**Why.** When ⌘Z appeared to do nothing, there was no way to tell *which* part
had failed — the keybinding, the recording, or the server call. A visible
control with a depth counter makes the state observable: if it reads `2`, the
stack has content and any failure is downstream of it.

That is the debugging argument. The product argument is stronger: a
keyboard-first tool still has to be discoverable. A shortcut nobody can find is
a feature that does not exist for most users, and D-002 committed us to dense
and keyboard-driven, not to hidden.

**Related fix.** `TaskRow` caught mutation errors and silently reset — so a
broken mutation looked identical to a UI ignoring clicks. Failures now surface
inline on the row.

*In one sentence:* a shortcut with no visible counterpart is undiscoverable and
undebuggable, so every one gets a control that also exposes its state.

### D-040
**Server actions run inside a transition and are always awaited** · 2026-09-01 · active

Never `void someServerAction(...)`. Always
`startTransition(async () => { await action(); ... })`.

**How this came up.** After fixing the undo stack (D-038), the button showed a
depth of 1 and clicking it displayed "Changed status" — but the row did not
move. The user reported it as "it says it undid, but it didn't."

**Two bugs in one line.** The undo handler ended with:

```js
setToast(describeBatch(inverse));
void undoAction(inverse);
```

1. **Outside a transition, Next.js never applies the refreshed page payload.**
   `revalidatePath` marks the route stale, but nothing re-renders the tree
   unless the action was dispatched inside a transition. The database write
   landed and the screen kept showing the old rows. This is why clicking a
   status dot worked — `TaskRow` wraps its calls in `startTransition` — and
   undo did not.
2. **Fire-and-forget makes the toast lie.** The success message was shown
   before the server had answered, so a *failed* undo also reported success.
   Confirmed the write path itself was fine: `db:smoke` asserts undo restores
   the previous value directly against Postgres, and passes.

**The fix.** Await inside a transition, toast only on success, call
`router.refresh()` as a second guarantee that the server components re-fetch,
and on failure push the inverse back onto the stack — a failed undo must not
also cost the user their history.

**The general rule.** A mutation is not complete when the promise is created;
it is complete when the server has answered *and* the UI reflects it. Any code
path that reports success before both have happened is lying to the user.

*In one sentence:* a fire-and-forget server action skips the re-render Next.js
does on revalidation and reports success before the server answers, so every
action is now awaited inside a transition and only confirms once it has landed.

### D-041
**One declaration table for field types, validated by hand** · 2026-09-02 · active

Every custom field type is declared once in `packages/core/src/fields.ts`:
its storage column, its legal filter operators, whether it is multi-valued,
whether it is computed, and a parser for its `typeConfig` blob. The parsers are
written by hand — @arbor/core still has exactly one dependency.

**Why a table at all.** The knowledge was previously spread across three places
that each re-derived it and could disagree: the compiler guessed the storage
column from the JavaScript type of a filter value, the mutation executor
guessed it again from the value being written, and nothing at all knew which
operators a type supports. Three guesses, three chances to differ. Now the
field is asked, and there is one answer.

**Alternatives.**

| Option | Why not |
|---|---|
| A schema library (zod, valibot) | The obvious pick, and the original code comment promised it. But every one of these needs a domain-specific message a generic validator won't produce — "S1 is not one of this field's options", "a rating must be a whole number between 0 and 3" — so the schemas would be as long as the parsers, plus a dependency. @arbor/core ships to the browser (`UndoStack` is imported by a client component), so its dependency list is bundle weight on every page. |
| Validate in the database with `CHECK` constraints | Cannot express "this option id exists in this field's own config blob", and a constraint violation surfaces as a Postgres error string, not a message a form can render next to the offending input. |
| Validate only in the UI | The API boundary is a server action; anything that trusts the client for shape has no boundary at all. |

**Trade-off.** Hand-written validators are more code than a schema library, and
adding a twenty-first field type means touching the table, the parser, and the
value parser rather than one schema. That is the intended cost: those three
places are exactly the three that must agree, and a compiler error at each is
how a new type gets finished rather than half-added.

**What would change our mind.** If `typeConfig` grows nested, recursive shapes —
a formula AST rather than an expression string — hand parsing stops paying and
a real schema library wins.

*In one sentence:* the field type is the single source of truth for storage,
operators, and validation, because the three places that used to infer it
separately were free to disagree — and one of them was already wrong.

### D-042
**The field decides its column; the compiler requires a catalog** · 2026-09-02 · active

`compileViewQuery` now takes a `fields` catalog, and refuses to compile a
definition that mentions a `cf:` field it was not given. The storage column
comes from the field's declared type, never from the JavaScript type of the
filter value.

**The bug this closes.** D-013 recorded it as a sharp edge and left it open:

```ts
// before — column chosen by inspecting the value
function valueColumnFor(value: unknown) {
  if (typeof value === "number") return "value_num";
  ...
}
```

Filter a *text* field with `op: "eq", value: 3` and the compiler emitted
`fv.value_num = 3`. Valid SQL, correct index, zero rows — and zero rows is
exactly what an empty list looks like. The failure was invisible: no error, no
warning, just a view that appeared to have nothing in it. A user's only
available conclusion is "there are no matching tasks", which is false.

**Alternatives.**

| Option | Why not |
|---|---|
| Keep inferring, but warn on a mismatch | There is nothing to compare against at that point. Inference *is* the guess; a warning would need the field's real type, and once you have that you no longer need to guess. |
| Look the field up inside the compiler | @arbor/core would need a database handle, which is the one thing it does not have and the reason its 118 tests need no fixtures. |
| Make the catalog optional, infer when it is absent | Two code paths, one of them known-wrong, and every caller that forgets the catalog silently gets the broken one. An optional correctness feature is not a correctness feature. |

**What the requirement bought beyond the fix.** Once the compiler knows the
type it can also refuse operators that make no sense (`>` on a dropdown),
route multi-value fields to JSONB containment instead of a scalar comparison,
sort a number column numerically rather than as text — `COALESCE(...::text)`
put 10 before 9 — and reject grouping by a field a task can hold several values
of at once.

**A second bug found on the way.** `isNull` on a custom field compiled to
`EXISTS (... AND fv.value_num IS NULL)`, which finds only tasks that have a row
holding a null — not the far larger set that has no row at all. "Is empty" now
means `NOT EXISTS (... IS NOT NULL)`.

**Trade-off.** Every call site that compiles a view must first load the fields
that view references — one extra query per request, and a new failure mode
("field not in the catalog") that used to be silent. That is the trade: a loud
failure at the boundary instead of a quiet wrong answer in the results.

**What would change our mind.** If catalog loading ever shows up in a profile,
cache it per workspace with the activity log as the invalidation signal — the
same mechanism derived fields already use. The interface does not change.

*In one sentence:* the compiler used to guess a custom field's storage column
from the type of the filter value, so a mistyped filter returned an empty view
instead of an error — now the field is asked, and a view that references a
field nobody loaded refuses to compile.

### D-043
**Deleting a status is a task migration, not a delete** · 2026-09-02 · active

`deleteStatus(statusId, replacementId)` moves every task using the status
first, as ordinary `setField` operations through `applyOperations`, and only
then removes the row. The replacement is a required argument.

**Why it cannot just be a delete.** `tasks.status_id` is `ON DELETE SET NULL`
(D-015 keeps everything else soft, but a status is genuinely gone). Deleting a
status therefore nulls the status of every task that used it — and a task with
a null status does not appear under any group header in a grouped view. From
the user's side, deleting the "Done" column silently empties it *and* hides the
work that was in it. The tasks are still there; nothing in the interface says so.

**Alternatives.**

| Option | Why not |
|---|---|
| `UPDATE tasks SET status_id = $new WHERE status_id = $old` | One statement, and it defeats the entire mutation layer: no activity row per task, no undo, no history on the tasks that moved. A user who picked the wrong replacement for 200 tasks has no way back. |
| Default the replacement to "the first status in the same group" | Silently reopens finished work when the deleted status was the only `done` one. A wrong guess here is invisible until a report is already wrong. |
| Soft-delete the status instead | Then a grouped view has to decide whether to render an archived column, filters have to hide it, and "restore" has to handle a set that has since changed shape. The migration is simpler and leaves nothing dormant. |

**What it costs.** 200 tasks is 200 operations and 200 activity rows in one
transaction, where the bulk UPDATE was one statement. That is the price of the
history, and it is the same price every other bulk edit in the product already
pays.

**One transaction, not two.** `applyOperations` gained an optional `client` so
it can join a transaction the caller already opened. Without it the migration
and the delete would commit separately, and a failure between them leaves tasks
moved for a status that still exists.

*In one sentence:* deleting a status nulls the status of every task that used
it, so the delete is preceded by a real migration expressed as undoable
operations — the user is asked where the tasks should go, and each one's move
shows up in its own history.

### D-044
**Configuration changes are in the same activity log as tasks** · 2026-09-02 · active

`object_kind` gained `status`, `status_set`, and `task_type`. Creating a
status, regrouping one, attaching a set to a folder — all write an `activity`
row with the actor, the old value, and the new one.

**Why.** "Who deleted the Done status?" and "why did every task in this list
change status on Tuesday?" are the two questions a shared workspace generates
after any configuration accident, and neither is answerable from the tasks
alone — the task rows show *what* changed, and attribute it to whoever
triggered the migration, but nothing records that a configuration edit was the
cause. A separate config-audit table would answer it, at the cost of two logs
to consult and two schemas to keep aligned.

**Trade-off.** The activity table now mixes two rates of change: task edits
(constant) and configuration edits (rare). The indexes are on
`(object_kind, object_id, at)`, so a task feed never scans configuration rows,
but a naive "everything that happened today" query now returns both — which is
usually what someone asking that question wants.

**What would change our mind.** If configuration events ever need a different
retention policy from task events — plausible under a compliance requirement —
they split into their own table, keeping the same row shape.

*In one sentence:* configuration edits go in the same append-only log as task
edits, because the question people actually ask after an accident spans both.

### D-045
**Changing a field's type is a data migration with a confirmation** · 2026-09-02 · active

`changeFieldType()` reads every stored value, re-parses it against the new
type, and refuses to run if any value would be lost unless the caller passes
`discardUnconvertible`. `previewFieldTypeChange()` returns the counts and a few
examples so the confirmation can say what is about to go.

**Why it is not a metadata edit.** Typed EAV (D-013) means values live in the
column their type chose. A `short_text` field becoming a `number` has to
physically move every value from `value_text` to `value_num`; leaving them
where they are produces a field that renders empty while its data sits in a
column nothing reads. So the choice is not "allow or forbid the edit" — it is
"which migration runs".

**Alternatives.**

| Option | Why not |
|---|---|
| Refuse type changes; tell the user to make a new field | Honest, and what the constraint tempts you into. But it pushes the migration onto the user as copy-paste across two columns, which loses history and is exactly the operation a computer should do. |
| Convert silently, dropping what fails | "About a week" is not a number, and there is no correct number to store. Dropping it without asking is data loss the user finds out about later, if at all. |
| Keep the old value in its old column as a backup | A row would hold two live values in different columns, and every reader would have to know which one counts. The activity row records the counts instead. |

**Trade-off.** The conversion writes one UPDATE per row rather than one
statement for the field. Fields hold at most one value per task, and a type
change is a rare deliberate act, so the cost lands where someone is already
waiting for a confirmation dialog.

*In one sentence:* typed columns mean a type change physically moves data, so
it runs as a real migration that reports what will not survive and refuses to
proceed until someone accepts that.

### D-046
**Fields accumulate down the tree; status sets override** · 2026-09-02 · active

A container's status set is the *nearest* one — its own, else an ancestor's.
Its custom fields are the *union* of every ancestor's, plus its own.

**Why the two rules differ.** A task has exactly one status, so two applicable
sets would be a contradiction the resolver has to break arbitrarily —
inheritance must pick one. A task can hold any number of custom fields, so
there is nothing to break: a list defining "Sprint" alongside its space's
"Story Points" is a complete, sensible answer.

Making fields override instead would mean defining a single local field
silently hides every shared one — never what the person adding it meant, and
invisible until someone notices a column is gone.

**Trade-off.** Fields cannot be *hidden* lower in the tree, only added. A list
that wants fewer fields than its space has no way to say so; the tool for that
is task-type scoping, which is a statement about the kind of work rather than
about the container. If a real case for hiding appears, it should be an
explicit per-container suppression, not a change to the inheritance rule.

*In one sentence:* a task has one status but many fields, so status sets
resolve to the nearest definition while fields accumulate — and the difference
is forced by the data, not a preference.

### D-047
**Configuration actions return failures, they do not throw** · 2026-09-02 · active

Every action in `config-actions.ts` returns `{ ok: true }` or
`{ ok: false, error }`. The task actions still throw.

**Why the two differ.** A task action fails when something is genuinely wrong —
the task was deleted, the database is unreachable. A configuration action fails
*as part of normal use*: "that name is taken", "12 tasks still use this
status", "a status set needs at least one done status". Those are answers, not
exceptions. They belong beside the control that produced them, and they have to
leave the half-filled form intact — an error boundary that replaces the screen
loses the six options someone just typed into a dropdown editor.

**Trade-off.** Callers can ignore the result and see nothing happen, which a
throw would have made loud. That risk is contained by every caller going
through the same `run()` helper, which sets the error state or refreshes.

*In one sentence:* rejected configuration edits are expected outcomes, so they
come back as values a form can render rather than exceptions that discard it.

### D-048
**A check that drives server actions over HTTP** · 2026-09-02 · active

`npm run check:actions` POSTs to the settings page with a `Next-Action` header
and the argument array — the same request a button click makes — and then
asserts against Postgres.

**Why.** Every layer already had coverage and the gap between them is where the
bugs were. @arbor/core has 147 unit tests; `db:smoke` runs the services against
real Postgres. Neither touches the seam where a handler calls a server action,
and that seam is exactly where the undo bug survived two confident fixes
(D-040) — both reasoned from the code, neither observed running.

The check catches things no unit test can see: that arguments survive
serialization, that the action runs with a real user, and that a *rejected*
edit comes back as a message rather than a 500.

**Alternatives.**

| Option | Why not |
|---|---|
| Playwright or similar | The right long-term answer and much heavier: a browser, a driver, and a fixture story for a project that currently needs `node` and a running dev server. Worth adding when there are interactions worth recording. |
| Trust the browser session | The browser extension has failed to connect across two sessions. A check that only runs when the tooling cooperates is not a check. |
| Call the service functions directly | That is `db:smoke`, and it skips the entire boundary this is about. |

**The honest limit.** This proves the action works when invoked. It does not
prove a click is wired to it, and it never will — that still needs a browser.
It converts "none of the screen is verified" into "the server half is".

**Fragility accepted.** Action ids are content hashes assigned at build time, so
the script reads the id-to-export mapping out of the dev build rather than
hard-coding it. If Next changes that manifest format, the script breaks loudly
at startup rather than silently passing.

*In one sentence:* the seam between a click and a service had no test and two
bugs, so there is now a check that sends exactly the request a click sends.
