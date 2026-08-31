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
