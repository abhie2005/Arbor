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
| [D-049](#d-049) | The undo stack stores inverses and does not invert again | Frontend |
| [D-050](#d-050) | A drop names its neighbours, not an index | Frontend |
| [D-051](#d-051) | Native HTML5 drag, no drag-and-drop library | Frontend |
| [D-052](#d-052) | The drag payload rides on `dataTransfer`, not React state | Frontend |
| [D-053](#d-053) | A refused edit reverts its control | Frontend |
| [D-054](#d-054) | The filter menu is built from the compiler's own rules | Query |
| [D-055](#d-055) | Filters live in the URL | Frontend |
| [D-056](#d-056) | A view is validated by compiling it before it is saved | Data |
| [D-057](#d-057) | "Exactly one default" is a database constraint, not a service rule | Data |
| [D-058](#d-058) | The saved view is the base; the URL layers over it | Frontend |
| [D-059](#d-059) | Never compare structures with `JSON.stringify` | Frontend |
| [D-060](#d-060) | Columns are refused on write and dropped on read | Query |
| [D-061](#d-061) | One SELECT list, wide enough for every built-in a column may name | Query |
| [D-062](#d-062) | Custom field values are fetched for the page, not projected | Query |
| [D-063](#d-063) | A cell arrives as a value, never as an id and a lookup table | Frontend |
| [D-064](#d-064) | One hook runs a task mutation from any control | Frontend |
| [D-065](#d-065) | Sort lives in the URL, and a header cycles through three states | Frontend |
| [D-066](#d-066) | Choosing columns writes to the view; filtering and sorting do not | Frontend |
| [D-067](#d-067) | A calendar day is stored at UTC midnight and read in UTC | Data |
| [D-068](#d-068) | A renderer may narrow the query; the URL may not widen it back | Query |
| [D-069](#d-069) | The sidebar counts the list, not the page | Query |
| [D-070](#d-070) | The rule about who sees what is pure, and lives in core | Auth |
| [D-071](#d-071) | The index is rebuilt inside the transaction that changed the grant | Auth |
| [D-072](#d-072) | A workspace always has a default status set | Data |
| [D-073](#d-073) | Inherited grants are shown, and cannot be removed where they are shown | Frontend |
| [D-074](#d-074) | scrypt from the standard library, not argon2id | Auth |
| [D-075](#d-075) | Every sign-in failure is the same failure | Auth |
| [D-076](#d-076) | A session is a row, and the token is never stored | Auth |
| [D-077](#d-077) | A renderer draws the status set the list resolves | Query |
| [D-078](#d-078) | A timeline is a nested clause, not a new query | Query |
| [D-079](#d-079) | The shell is a component, extracted at the sixth copy | Frontend |
| [D-080](#d-080) | Authenticating is not authorizing, and every write does both | Auth |
| [D-081](#d-081) | Configuration is administered; a view is authorized as two things | Auth |
| [D-082](#d-082) | A task is a page, and the key is what opens it | Frontend |
| [D-083](#d-083) | A comment is an operation, and its body is a document | Architecture |
| [D-084](#d-084) | A mention may grant access, but never quietly | Auth |
| [D-085](#d-085) | The shell fetches the badge; nobody hands it one | Frontend |
| [D-086](#d-086) | A screen may be nowhere in the tree | Frontend |
| [D-087](#d-087) | Read state is not the workspace, so it is not an operation | Architecture |
| [D-088](#d-088) | A mark on the feed, not a flag on every event | Architecture |
| [D-089](#d-089) | One stream, two halves | Frontend |
| [D-090](#d-090) | A nudge over Postgres, not a delta over Redis | Architecture |

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

### D-049
**The undo stack stores inverses and does not invert again** · 2026-09-02 · active

`UndoStack.pop()` returns the batch it was given, unchanged. It used to return
`invertBatch(batch)`.

**This is the root cause of the undo bug**, open since 2026-09-01 and the
subject of two previous fixes that were both real bugs and neither the
explanation (D-038, D-040).

**The composition nobody tested.** Two correct decisions met and produced a
wrong result:

- **D-036** — the server decides what an operation's inverse is, because only
  the server knows the value a field held before the write. Every action
  therefore *returns the inverse*: `cycleStatus` applies `todo → doing` and
  hands back `{ from: doing, to: todo }`.
- **UndoStack** — modelled as a stack of operations *as applied*, inverting on
  the way out. That is the textbook design, and it is right when the stack
  holds forward operations.

The client pushed the server's inverse into a stack that inverted again. Undo
therefore re-applied the original change. The task was already in that state, so
the row did not move — and because the operation was not a no-op by
`from`/`to` comparison, it wrote a row, logged activity, and returned success.
The toast said "Changed status" and nothing happened. Exactly the reported
symptom.

**Why every test passed.** This is the instructive part. `invert` had 24 unit
tests. `db:smoke` proved the write path against real Postgres — it calls
`invertBatch` on the *forward* operation, which is the correct single
inversion. `UndoStack` had seven tests, every one of them pushing a forward
operation and asserting the pop was inverted. Each layer was correct in
isolation and tested in isolation. The defect existed only in the seam, and
nothing tested the seam.

**Why the two earlier fixes missed it.** Both were reasoned from reading the
code, because the browser extension would not connect. Reading finds bugs in a
layer. It does not find a disagreement between two layers that each look right,
because the reader carries one mental model into both.

**How it was actually found.** By sending the `undo` server action the request
a click sends and checking Postgres afterwards. The write landed *and* the
response carried a refreshed payload — which ruled out both hypotheses the
status file was holding, and pointed at the only remaining place: what the
client had put in the request.

**The fix, and why it is that direction.** The stack now stores what it is
given. The inversion has to stay on the server (D-036), so the client's job is
to hold the inverse and hand it back. `pop()` carries a one-line comment saying
so, and `check:actions` runs the whole composition — real action, real stack,
real database — so reintroducing the double inversion fails a check rather than
shipping.

**The general lesson.** When two layers can each perform a transformation,
exactly one of them must, and which one has to be written down where both can
see it. Unit tests cannot catch this class of bug by construction: each layer
passes its own tests precisely because each is doing what it was designed to do.

*In one sentence:* the server returns the inverse and the stack inverted it
again, so undo re-applied the change it was meant to reverse — two correct
layers composing into a wrong answer, which is why isolated tests all passed and
only a request that crossed both found it.

### D-050
**A drop names its neighbours, not an index** · 2026-09-05 · active

`moveTask(taskId, statusId, beforeTaskId, afterTaskId)`. The client says which
two cards it dropped between; the server reads their positions and computes a
fractional key between them.

**Why not an index.** An index is a claim about a list the client rendered a
moment ago. By the time the request lands, someone else may have inserted a
card, archived one, or moved the neighbour — and "position 3" now means a
different place than the user pointed at. Card ids are rows: they mean the same
thing on both sides of the wire, and if a neighbour has since moved, the drop
still lands next to *the card the user aimed at*, which is what they meant.

It also keeps the write small. Resolving an index server-side means reading the
column and renumbering it; resolving neighbours means reading two rows and
writing one (D-012).

**Trade-off.** If both neighbours are deleted between render and drop, the
computed key is `positionBetween(null, null)` — the card lands at the top of the
column rather than failing. That is a defensible answer to an unanswerable
question, but it is a guess, and worth revisiting if it ever surprises anyone.

*In one sentence:* indices describe a screen that may already be stale, so a
drop names the rows it landed between and the server turns those into a key.

### D-051
**Native HTML5 drag, no drag-and-drop library** · 2026-09-05 · active

Board drag is `draggable`, `onDragOver`, and `onDrop`, plus a two-line midpoint
test to decide whether the pointer is above or below a card.

**Why.** dnd-kit and react-beautiful-dnd are both good, and both are a
permanent dependency, a bundle cost on every board, and a component library
whose DOM and focus behaviour would need re-tokenizing against the design
system — the same argument as D-030, applied to behaviour rather than looks.
What they buy is keyboard dragging, touch support, and collision detection for
complex layouts. A single-axis list of cards in columns needs none of that yet.

**Trade-off, stated plainly.** Native drag has no keyboard equivalent, and D-039
committed this project to every interaction having one. That is a real gap, and
the honest resolution is not a library: it is that moving a task between
statuses already has a keyboard path — the status control on the row — and
reordering within a column does not yet. When it needs one, it should be a
command, not a simulated drag.

Touch is also unsupported, which native drag simply does not do. A board on a
tablet will need something else, and that is the point at which a library
earns its place.

*In one sentence:* the browser already does single-axis dragging, so the
library's real value is keyboard and touch — neither of which a library would
give this board correctly anyway, and both of which are honest gaps rather than
solved problems.

### D-052
**The drag payload rides on `dataTransfer`, not React state** · 2026-09-05 · active

`onDrop` reads the dragged task id from `event.dataTransfer.getData("text/plain")`.
React state still tracks the drag, but only for the visual parts: dimming the
card and placing the insertion line.

**How this was found.** Dispatching `dragstart`, `dragover`, and `drop` in a
single tick moved nothing. Spacing them 300ms apart worked. The difference was
not the events — it was that `setDragging` had not committed by the time the
drop handler read it, so `dragging` was still `null` and the handler returned
early without a sound.

A real user's drag always spans frames, so this would probably never have bitten
in production. "Probably never" is doing a lot of work in that sentence: the
same shape of bug — write state in one event, read it in another, assume a
commit in between — is exactly what breaks under a slow render or a busy main
thread, and it fails silently by design.

**The fix is what the API was always for.** `dataTransfer` is the drag API's
payload channel. It is set on `dragstart` and readable on `drop` regardless of
what React has committed, because the browser carries it, not the component.
The code already called `setData` — for Firefox, which refuses to start a drag
without it — and then ignored the value on the way out.

**The rule.** If two separate events must agree on a value, the value belongs
somewhere both can see without a render in between. React state is for what the
screen shows, not for what the browser is carrying.

*In one sentence:* the drop handler read the dragged id from React state, which
is only there if a render happened between two events — so it now reads it from
`dataTransfer`, which the browser carries and no render can miss.

### D-053
**A refused edit reverts its control** · 2026-09-05 · active

The `run()` helper in each settings component takes an optional `revert`
callback, invoked when the server returns `{ ok: false }`.

**What it looked like without one.** Renaming "In Progress" to "Todo" — a name
already taken — showed the error correctly *and* left the input reading "Todo".
Two rows both said "Todo" while a message underneath explained that the rename
had not been allowed. The screen was displaying a state that existed nowhere.

**Why it happened.** D-047 made configuration actions return failures instead of
throwing, which is right: a rejected edit is a normal outcome that belongs next
to the control. But returning a value means nothing unwinds automatically, and
optimistic local state stays optimistic about something that did not happen.
`TaskRow` already did the resetting by hand; the settings components did not.

**The general rule.** Anywhere a control holds a local copy of server state,
the failure path has to restore it. Showing an error is not enough — the user
reads the screen, not the error.

*In one sentence:* an optimistic input that survives a rejection is a lie the
error message sits next to, so a refused edit now puts the control back.

### D-054
**The filter menu is built from the compiler's own rules** · 2026-09-05 · active

`filterableFields()` and `operatorsFor()` in @arbor/core publish the same
knowledge the compiler validates against. The filter bar builds every menu from
them: which fields can be filtered, which operators each one allows, and which
control the value needs.

**Why publishing beats validating.** The compiler already rejects a nonsense
filter (D-042) — but rejection is the last line, not the interface. A UI that
offers `>` on a dropdown has already failed the user before the server ever
answers: they made a choice, waited, and were told it was never possible. The
menu should not be able to express an invalid filter in the first place.

The alternative is two lists of what is legal — one for the menu, one for the
compiler — which is a guarantee they will disagree, and the disagreement will
be discovered by a user.

**A test enforces the contract**: every operator the metadata offers for a
built-in field is the exact set `operatorsFor` returns. If someone adds an
operator to one and not the other, that fails rather than shipping.

**Choice fields carry their own values.** A dropdown's legal values are defined
by the field, so the options travel with it. Without that the UI offers a text
box whose only valid input is an option's uuid — which nobody knows and nobody
should have to type. Finding this needed the screen: the operator list was
right and the value control was useless, and only one of those is visible in a
unit test.

*In one sentence:* the menu and the validator read the same declaration, so the
UI cannot offer a filter the server will reject.

### D-055
**Filters live in the URL** · 2026-09-05 · active

The filter state is a `?f=` parameter holding a compact JSON array of
`[field, operator, value]` triples. Nothing about the current filter is held in
component state.

**Why.** A filtered view is the thing people send each other — "everything
overdue and unassigned". Component state makes exactly the most useful views
unshareable, and loses them on reload and on back.

**The encoding is tuples, not the full condition shape**, because the URL is
read by a human in a Slack message and
`?f={"c":[["dueAt","lt","2026-09-01"]]}` survives that better than forty
characters of repeated key names.

**Decoding is untrusted-input handling.** Anyone can edit a URL. The decoder
validates *structure only* — an array of triples with a known operator — and
leaves every semantic question to the compiler, which already answers all of
them. Duplicating the field list would give it two places to drift.

**A malformed link is an error page, not an empty filter.** Dropping a bad
condition silently would render an unfiltered view that looks filtered: the
same failure shape as D-042, where a wrong answer is indistinguishable from a
legitimate one. The page names the problem — "Filter 1 uses an unknown
operator: sideways" — and offers a link that clears it.

**Trade-off.** URLs get long and ugly with several filters, and a saved view
will eventually be the better home for a complex one. The URL stays the
transport either way: a saved view is a name for a definition, and opening it
still puts that definition in the address bar.

*In one sentence:* a filtered view is something people share, so the filter
lives in the address bar, and a link that cannot be parsed says so instead of
quietly showing everything.

### D-056
**A view is validated by compiling it before it is saved** · 2026-09-05 · active

`createView` and `updateViewDefinition` run the definition through
`compileViewQuery` and refuse to write if it throws.

**Why write-time and not read-time.** A definition that will not compile is a
view that cannot open. Validating on read means the person who discovers that is
whoever clicks it next — often a teammate, often weeks later, with none of the
context needed to fix it. Validating on write puts the failure in front of the
person who caused it, while they still have it.

The check is close to free: the compiler is pure, touches no database, and
never runs the query it builds. The only real cost is loading the field catalog,
which the save path needs anyway.

**What it catches.** Anything the compiler rejects: an operator a field type
does not support, a `cf:` reference to a field that no longer exists, a sort on
a multi-value field, more filters than the ceiling allows. All of these are
reachable from a UI that is a version behind, or from a hand-edited URL that
someone then saves.

**Trade-off.** A view saved today can still stop compiling tomorrow — delete
the custom field it filters on and it breaks retroactively. Write-time
validation cannot prevent that, which is why the field catalog deliberately
keeps archived fields (D-045) and why the filter bar renders an unknown field
as a removable chip rather than crashing. Validation on write narrows the
window; it does not close it.

*In one sentence:* saving a view is saving a query, so it is compiled first —
the failure belongs to whoever wrote it, not to whoever opens it next.

### D-057
**"Exactly one default" is a database constraint, not a service rule** · 2026-09-05 · active

`views` has a partial unique index on `(parent_id) WHERE is_default`, and
`task_types` has the same on `(workspace_id) WHERE is_default`.

**Why not just the service.** The services already clear the old default inside
the transaction that sets the new one, which is correct — for exactly as long as
every writer remembers to do it. Seed scripts, migrations, a fixture, and a psql
session at 2am are all writers. "Which view opens when I click this list" and
"which type does a new task get" must have exactly one answer, and a partial
unique index makes the second answer unrepresentable rather than merely
unlikely.

The service still clears the old default first — not to hold the invariant, but
so the write succeeds instead of hitting the constraint.

**A schema bug found on the way.** `views.is_default` was declared `text`. It
had never been written to, so nothing was broken yet, but the first person to
set a default would have been storing the string `"true"`. Migration 0002 makes
it boolean.

**That migration is hand-edited**, and the header says why: drizzle-kit emitted
a bare `ALTER COLUMN ... SET DATA TYPE boolean`, which Postgres rejects because
there is no assignment cast from text to boolean, and the generated `SET NOT
NULL` would then have failed against existing NULL rows. Generated migrations
are a starting point, and reading them before applying is the job.

*In one sentence:* invariants that every future writer must respect belong in
the schema, because the schema is the only writer that cannot forget.

### D-058
**The saved view is the base; the URL layers over it** · 2026-09-05 · active

`loadView` loads the saved view first, then applies `?f=` on top of *its*
filters. The tab strip shows "Unsaved filter" when the two differ, with Save,
Save as new, and Reset.

**The bug this replaced.** The page decoded `?f=` against the built-in default
filters and passed the result to `loadView` as an override — so a saved view's
own filters were overwritten on every render and never applied at all. A view
saved with "priority is urgent" opened showing everything. Saving worked; only
opening was broken, which is the harder half to notice.

**Why layering is the right model.** A saved view is a starting point, not a
cage: filtering it further is the most common thing anyone does with one, and
that exploration should be shareable (D-055) without being a commitment. Making
the URL win *over the saved filters* — rather than instead of them — is what
makes "Reset" meaningful and "Save" a deliberate act.

**`dirty` is computed on the server**, because only that side knows which parts
of a definition the renderer overrides. The list forces `showSubtasks: 3` and
the board forces `1`; neither is a change the user made, and comparing whole
definitions on the client reported every view as unsaved the moment it opened.

*In one sentence:* a saved view supplies the filters and the URL refines them,
so exploring a shared view is free and changing it for everyone is a button.

### D-059
**Never compare structures with `JSON.stringify`** · 2026-09-05 · active

Filter comparison reduces each condition to a key assembled in a fixed order,
rather than stringifying the objects.

**How this bit.** `sameFilters` compared `JSON.stringify(a)` to
`JSON.stringify(b)`. Saving a view worked, the row was correct in Postgres, and
the "Unsaved filter" banner never went away — on a view that had just been
saved.

`JSON.stringify` serializes keys in insertion order. A condition built by the
decoder is `{field, op, value}`. The same condition after a round trip through
a `jsonb` column comes back `{op, field, value}` — Postgres does not store
`jsonb` object keys in input order and is documented not to. Two equal objects,
two different strings, forever.

**The general rule.** `JSON.stringify` answers "are these the same *text*",
which is only the same question as "are these the same *value*" when nothing
has crossed a boundary that may reorder keys. A database, a cache, and a
structured-clone all may. Compare structurally, or build a canonical key with
an order you control.

**Trade-off.** The key builder has to be updated when `FilterGroup` grows a
field. That is a real maintenance cost and it is the correct one: an
order-sensitive shortcut fails silently and intermittently, which is
considerably more expensive than remembering to add a line.

*In one sentence:* two identical filters compared unequal because Postgres
returns `jsonb` keys in its own order, so equality is now structural rather
than textual.

### D-060
**Columns are refused on write and dropped on read** · 2026-09-05 · active

`validateColumns` throws on a column that names nothing; `resolveColumns`
silently drops one and reports it in `dropped`. Same knowledge, two behaviours,
chosen by which end is calling.

**Why not one rule.** The instinct is to be consistent, and consistency here
picks the wrong behaviour at one of the two ends. Throwing at read time means a
single deleted custom field takes every saved view that mentioned it off the
air — and because `resolveColumns` runs inside `loadView`, which every renderer
reads through, that is the list and the board going dark over a column neither
of them draws. Dropping at write time means saving a view appears to succeed
and quietly discards part of what was saved.

So: refuse where a person is present and can fix it, degrade where they are
not. The rejected alternative — validating only on write and trusting the
database afterwards — ignores that a field can be deleted *after* a view
referencing it was saved, which no amount of write-side validation prevents.

**Hidden columns are validated too.** A hidden column is a remembered width and
position, not a discarded one; un-hiding it later must not be able to fail.

*In one sentence:* a broken column is a mistake worth refusing when it is being
made and not worth breaking a screen over afterwards.

### D-061
**One SELECT list, wide enough for every built-in a column may name** · 2026-09-05 · active

The compiler projects every single-valued built-in — including
`task_type_id`, `created_at`, `created_by` and `completed_at`, which no
renderer read before the table — rather than selecting per view definition.

**The alternative was projecting what the definition asks for**, which sounds
tidier and is worse. It makes the SELECT list vary by view, so the
prepared-statement text differs per view; it means a renderer that wants to
show one more field needs the compiler to agree; and it turns "add a column to
this view" into a query change, which is exactly the coupling the one-compiler
bet exists to avoid (D-017).

These are all columns on `tasks` — no extra join, and a few bytes per row for
renderers that ignore them. Multi-valued fields stay out: assignees, watchers
and tags live in child tables, and projecting them would multiply rows, which
is the one thing the no-DISTINCT rule (D-020) depends on not happening.

**A test asserts the two tables agree** — every entry in `BUILTIN_COLUMNS`
whose kind is single-valued must appear in the compiled SELECT list. The drift
it guards against is silent: a column offered in a header whose value never
arrives renders as an empty cell in every row, which reads as "no data" rather
than "never selected".

*In one sentence:* the row is a little wider so that adding a column to a view
is never a change to the query.

### D-062
**Custom field values are fetched for the page, not projected by the compiler** · 2026-09-05 · active

`loadView` runs the compiled query, then one lookup for the values its visible
columns need: `WHERE task_id = ANY(...) AND field_id = ANY(...)`.

**The alternative was projecting each visible column** as a correlated
subquery, the way `orderExpr` already does for sorting. It is the more obvious
answer — the compiler owns the query, and columns are part of the definition —
and three things are wrong with it. A fifteen-column table compiles fifteen
subqueries. The query *text* then changes whenever someone shows or hides a
column, so no two views share a prepared statement. And a renderer wanting one
more field becomes a compiler change, which is the coupling D-017 exists to
prevent.

**This is not a renderer growing its own query.** The rule the project holds is
that a renderer must not query — if it needs to, the compiler is missing
something (D-032). The lookup lives in `loadView`, which is the shared read
path and already does exactly this for assignees and subtask counts. What a
renderer may not have is a *different idea of which rows exist*; a second
lookup keyed by ids the compiler already returned cannot produce one.

**Why it is permission-safe.** Every task id it takes came out of the
permission-scoped query. This lookup can only narrow what the viewer was
already served, never widen it. That property depends on nothing in it taking
an id from anywhere but those rows, which is the constraint to preserve if it
grows.

**Only the lookups a column asks for run.** The list and the board resolve to
columns needing none, so they pay nothing — verified by diffing both pages'
rendered DOM before and after this change: identical.

*In one sentence:* one indexed lookup for the page beats one subquery per
column, and it belongs to the read path rather than to any renderer.

### D-063
**A cell arrives as a value, never as an id and a lookup table** · 2026-09-05 · active

`cellsFor` runs on the server and returns a discriminated union — `{k:
"people", names: ["Avery Mills"]}`, not a user id for the client to resolve.
The table component never sees the people, tag, container or task maps.

**Two things go wrong when the client joins.** It needs the maps, so rendering
nine visible rows ships every person, tag and container in the workspace to the
browser. And a missing name becomes a second place that has to decide what to
do about it, which is how a table ends up printing a raw uuid at someone.

**The union is the contract.** A `Cell` has a `k` the renderer switches on
exhaustively, so a column kind added without a cell to draw it is a type error
rather than a column of blanks — the same failure shape the SELECT-list guard
in D-061 exists to catch, one layer up.

**Deleted dropdown options render as an unnamed chip.** A value stores the
option id, never its name (D-041), so removing an option from a field leaves
values pointing at nothing. Showing the uuid is worse than showing nothing, and
dropping the chip entirely would hide that a value is still stored.

*In one sentence:* the server resolves cells to values because it already has
everything needed to, and the browser does not.

### D-064
**One hook runs a task mutation from any control** · 2026-09-05 · active

`useTaskAction` holds the four behaviours a control needs when it writes: run
inside a transition and await it (D-040), push the server's inverse unchanged
(D-049), show the failure, and revert the control to the server's value
(D-053).

Each of those was learned separately, three of them from a bug. A second
renderer with its own copy of the list is a second place for one to go missing
— and the one that goes missing quietly is the last, because a control still
showing a value the server refused looks exactly like a control that worked.

*In one sentence:* the rules for writing from a control are one function, so a
new renderer inherits them instead of reimplementing them.

### D-065
**Sort lives in the URL, and a header cycles through three states** · 2026-09-05 · active

`?s=[["dueAt","desc"]]`, layered over the saved view's own sort exactly as
`?f=` layers over its filters (D-055, D-058). A header goes unsorted →
ascending → descending → unsorted.

**The third state is the one worth arguing for.** Two-state headers are more
common and they strand the saved view's own order: these lists are sorted by
`position`, which is the order people dragged things into, and once anyone
clicks a header there is no way back to it short of reopening the view. Making
the third click remove the parameter means "put it back" is a click rather
than a thing you have to know.

**Headers are links, not buttons.** Sorting is a navigation to another address
for the same view, so it lands in history, opens in a new tab, and works before
the page has hydrated — which on this machine is several seconds (a button
would silently do nothing in that window).

**Multi-value columns say why they cannot sort.** `orderExpr` refuses a set,
so assignee, tag and labels columns render as plain text with a title
explaining it, rather than as a control that looks live and does nothing.

**"Unsaved filter" became "Unsaved changes"**, and Save now writes the sort
too. A banner that offers to save a view while quietly dropping half of what
the user changed is worse than no banner.

*In one sentence:* a sorted table is an address you can send someone, and the
saved order stays one click away.

### D-066
**Choosing columns writes to the view; filtering and sorting do not** · 2026-09-05 · active

The column chooser calls `saveViewDefinitionAction` directly. Filters and sort
go in the URL and wait for a Save (D-055, D-065).

**Why the two are different.** A filter is a question someone is asking of a
view — "just the overdue ones" — and it should be shareable without changing
what everyone else opens. A column set is not a question; it is what the view
*is*. Nobody adds a column meaning "temporarily, for me": they add it because
the view was missing something. Putting a fifteen-column definition in the
query string to make it feel consistent would produce unreadable links for a
change nobody wanted to be temporary anyway.

**Hiding keeps the entry.** A hidden column keeps its position and width in the
definition, so switching one off and back on returns it where it was rather
than appending it to the end. That is also why the menu lists columns in
definition order rather than alphabetically — what you reorder is what you see,
including the parts currently switched off.

**A view-less table refuses instead of pretending.** When no saved view of the
type exists, the renderer falls back to a constant definition, which has
nowhere to keep a change. Saying so beats accepting the click and losing it on
reload.

*In one sentence:* filters and sorts are how someone reads a view, columns are
what the view is, and only one of those belongs in a URL.

### D-067
**A calendar day is stored at UTC midnight and read in UTC** · 2026-09-05 · active

`due_has_time = false` means the value is a day, not a moment. Such a value is
now written at midnight UTC and formatted with `timeZone: "UTC"`; a value with
a time is written and read wherever the reader is.

**The flag existed and nothing read it.** The column has carried a comment
since the first migration saying a date-only due date silently shifts a day
across timezones. All three renderers formatted every date with
`toLocaleDateString` and no zone, and the seed wrote "now + n days" — so a task
stored on the 4th displayed as the 3rd on this machine, which is seven hours
behind UTC.

**Why it stayed invisible.** A row saying "3 Sept" is only wrong if you know
what was stored. Nothing on the screen contradicted it, and no test compared a
rendered date to a database value. The calendar is what makes it visible,
because a task in the wrong square sits next to the right ones.

**Overdue moved with it.** Comparing a date-only value to `Date.now()` marks
anything due today as late from one minute past midnight. A day is overdue when
the day is over.

**What this does not fix.** Users have no timezone, so an instant is rendered
in the server's zone during SSR and the browser's afterwards. That is a real
gap and it belongs with real identity (Phase 5); this decision is only about
which frame a *day* is read in, which has one right answer and does not depend
on knowing who is asking.

*In one sentence:* the column always said a date-only value is a calendar day,
and now everything that reads it agrees.

### D-068
**A renderer may narrow the query; the URL may not widen it back** · 2026-09-05 · active

`loadView` takes `required` conditions, appended after `?f=` has been layered
on. The calendar uses one: the date falls inside the six weeks on screen.

**Why not an override.** Renderer overrides merge into the definition, so
passing `conditions` would replace whatever the saved view filters on — a
calendar would silently drop a view's own filters. Appending keeps both, and
appending *last* means a hand-edited link cannot remove the month while still
claiming to show it.

**They are deliberately invisible to the filter bar.** The bar builds from the
definition, and a "due date is between the 31st and the 12th" chip sitting there
with a remove button invites someone to break the screen. A renderer's scope is
not a filter the user set.

**The calendar needed no compiler change.** This is the measurement STATUS was
waiting for, and the interesting part is what carried it: `between` already
existed, the access-index join already scoped it, and a month is at most a few
hundred rows, so placing each in a square is arithmetic rather than a `GROUP BY
day`. The page size is raised to the compiler's maximum instead — a month is a
bounded window, not a page someone scrolls, and a task missing because it fell
past a limit would look exactly like one that is not scheduled.

*In one sentence:* a renderer's scope is part of the query and not part of the
view, so it is appended where nothing downstream can take it off.

### D-069
**The sidebar counts the list, not the page** · 2026-09-05 · active

`listTaskCount` is compiled per render — grouping by `list` with the scope
already set to this container — rather than taken from `rows.length`.

**What it was.** Every page put `data.rows.length` next to the list's name. The
list hides subtasks and showed 7; the table shows them and showed 9; the
calendar filters to a month and showed **0 in October**, which reads as an empty
list rather than an empty month.

**Counted through the compiler, not with a query of its own.** The number has to
respect the access index, soft deletes and archiving, and there is one place
that knows all three (D-019). A hand-written `COUNT(*)` beside it would be a
second answer to "what may this viewer see" — which is the failure mode the
materialized index exists to prevent.

*In one sentence:* a number beside a list's name is about the list, so it is
counted once and not left to whichever renderer happens to be open.

### D-070
**The rule about who sees what is pure, and lives in core** · 2026-09-06 · active

`resolveAccess(containers, grants, members, groupMembers)` returns the rows of
the access index. It has no database in it, so the rule can be tested without
one and cannot differ between the job that rebuilds the index and anything else
that asks.

Three rules produce every row: an open list is reachable by every member at the
permission their role implies; a list that is effectively private is reachable
only through an explicit grant on it or above it; and the strongest applicable
permission wins.

**The owner is the exception to privacy; the admin is not.** An owner reaches
every list because the alternative is a workspace whose owner can be locked out
of their own data. An admin does not, because a private space an admin can
silently read is not private — "admin" is permission to administer, not to
read. That asymmetry is the kind of thing that gets decided by accident in a
query somewhere; here it is one branch with a test named after it.

**A guest's baseline is `null`, not `view`.** A guest is someone invited to
specific things, so "everything not marked private" is precisely the wrong
default. Grants are the only way a guest reaches anything.

**A grant never lowers what a role already gives.** Sharing something with
someone must not take access away, so the merge is strongest-wins rather than
last-wins.

*In one sentence:* the question every query depends on is answered by one pure
function with 26 tests, rather than by SQL nobody can exercise in isolation.

### D-071
**The index is rebuilt inside the transaction that changed the grant** · 2026-09-06 · active

`grantAccess`, `revokeAccess` and `setContainerPrivacy` recompute the whole
workspace's index before they commit. ADR 3 describes this as a background job;
it is synchronous for now, deliberately.

**Because eventual consistency on a revocation is a leak.** ADR 3 accepts a
stale window and says revocations that must be immediate need a direct delete.
Doing the rebuild in the same transaction means there is no window at all: the
grant and the access it implies land together or neither does.

**Whole-workspace, not incremental.** A container tree is hundreds of rows, and
an incremental rebuild has to work out what a change implies — which is exactly
the reasoning that goes wrong quietly, and wrongly here means someone reads what
they should not. `affectedLists` exists for when a workspace is big enough that
this matters; until then, recomputing everything is the version that cannot
drift. The rebuild is idempotent by construction (delete, then insert what the
rule says), so it can be re-run whenever anything is unsure.

**The trade being accepted:** a share costs a full rebuild. At a thousand lists
and a hundred members that is a hundred thousand rows, and this becomes a
queued job with the immediate-delete escape hatch ADR 3 already describes.

*In one sentence:* a permission change is not eventually correct, it is correct
when it commits — and that is worth a rebuild per share until the numbers say
otherwise.

### D-072
**A workspace always has a default status set** · 2026-09-06 · active

The seed creates one attached to nothing, alongside the set attached to the
Engineering space. `resolveStatusSet` walks container → ancestors → workspace
default and throws if all three come up empty.

**The throw is correct; the data was wrong.** With one space, whose tree held
the only set, nothing had ever asked about a container outside it. Adding a
second space made `/settings/statuses` return 500 — from a function doing
exactly what it should, because guessing a status set for a container that has
none is how tasks end up in a status their list does not have.

**So the invariant belongs in the data**: a workspace has a default, and every
container therefore resolves something. A smoke check now asserts it for *every*
container rather than for the demo list, which is the shape of check that would
have caught this before a screen did.

*In one sentence:* a function that refuses to guess is only as useful as the
data that stops it having to.

### D-073
**Inherited grants are shown, and cannot be removed where they are shown** · 2026-09-06 · active

The sharing panel lists a container's own grants and the ones it inherits,
labelled with where they came from. Only its own have a Remove button.

**Showing them is the point.** A panel listing only a container's own grants
tells someone their list is unshared while the space above it is open to
everyone — which is precisely the misunderstanding that leaks things.

**Not removing them is the honest half.** A grant on a parent cannot be undone
from a child; the fix is either a change further up or making this container
private. A Remove button that silently did nothing, or that quietly made the
container private as a side effect, would both be worse than no button.

**The number beside each container is read from the access index**, not counted
from its grants. The index is what queries actually join against, so if the two
ever disagree, this screen shows what is true rather than what was intended.

*In one sentence:* the screen shows the whole picture including the parts it
cannot change, and says which is which.

### D-074
**scrypt from the standard library, not argon2id** · 2026-09-06 · active

Passwords are hashed with `node:crypto`'s scrypt at N=2^16, r=8, p=1 — roughly
64 MB and 100 ms per hash.

**Argon2id is the better function and every guide says so.** It is also a
native module. This project is meant to be cloned and run with Node and Docker
and nothing else; a compile step in `npm install` is a cost paid by every
self-hoster, on every architecture, forever, and it is the kind of cost that
turns "clone and run" into "clone and read the build errors". scrypt is
memory-hard, it is in the standard library, and at these parameters it is the
same order of work.

**The stored hash names its own algorithm and parameters**
(`scrypt$N$r$p$salt$hash`), so raising the cost or moving to argon2id later is
a rehash on next sign-in rather than a migration — which is the property that
makes this a reversible decision rather than a permanent one.

*In one sentence:* the second-best hash in the standard library beats the best
one behind a compiler, for a project whose promise is that it runs anywhere.

### D-075
**Every sign-in failure is the same failure** · 2026-09-06 · active

"That email and password do not match an account", for an unknown address and
for a wrong password alike. An unknown address is also verified against a dummy
hash, so both paths cost the same.

**Because the difference is an oracle.** A form that says "no account with that
email" lets anyone check which addresses are registered, one request at a time
— which matters more for a work tool than most places, since the addresses are
colleagues' and the answer is "where these people work".

**The timing has to match too**, or the message refusing to answer is undone by
how long it takes to refuse. The dummy hash is derived once per process; doing
it per miss would be its own signal.

**The cost is a worse error message**, and it is a real cost — someone who
mistyped their address gets no help. That is the trade every serious login form
makes, and the place to help them is a password reset flow that also refuses to
say whether the address exists.

*In one sentence:* the login form answers one question, and "does this person
have an account" is not it.

### D-076
**A session is a row, and the token is never stored** · 2026-09-06 · active

Signing in inserts into `sessions` with a SHA-256 of a 32-byte random token;
the token itself exists only in an httpOnly cookie. Signing out deletes the
row.

**Server-side sessions rather than a signed stateless token**, because
revocation has to be immediate and true. A JWT is valid until it expires no
matter what the server thinks; a row can be deleted, which is what "sign out
everywhere" and "this account is compromised" actually need. The cost is a
lookup per request, which is one indexed read against a table the connection
pool is already talking to.

**Hashed, for the same reason the password is.** A database that leaks hands
over no live sessions.

**The development switcher survives underneath it** (D-034), not instead of it:
it applies only when its cookie is explicitly set, so a browser with no cookies
is signed out and meets the login screen. It used to fall back to "the first
user", which meant nobody was ever signed out in development and the login
screen could not be reached — a screen nobody can reach is a screen nobody
tests.

*In one sentence:* sessions are rows because the important operation is not
issuing them, it is ending them.

### D-077
**A renderer draws the status set the list resolves, not every set in the workspace** · 2026-09-06 · active

`loadView` calls `resolveStatusSetFor(workspace, list)` and renders that set's
statuses. It used to select every status in the workspace.

**It worked for exactly as long as there was one set.** Adding a workspace
default (D-072) put "Open 0 · Doing 0 · Done 0" on the list beside the real
sections — statuses belonging to a set this list does not use. The list was
never asking the right question; there had only ever been one answer.

**The filter bar still offers all of them**, deliberately: a filter can be
written on a view that spans lists with different sets, so restricting the menu
to one list's statuses would refuse filters the compiler accepts.

*In one sentence:* what a list shows comes from what the list inherits, and
what a filter may say comes from the whole workspace — they are different
questions with the same-looking answer until they are not.

### D-078
**A timeline is a nested clause, not a new query** · 2026-09-06 · active

The Gantt view runs the same compiled query as every other renderer, scoped by
a nested filter clause: `(start IS NULL OR start < end) AND (due IS NULL OR due
>= begin) AND (start IS NOT NULL OR due IS NOT NULL)`.

**This is the renderer STATUS expected to break the bet, and it half did.** The
bet was that a new view type needs no query of its own. That held — no new SQL,
no join, no second query. What did not hold was that the *compiler could
already say everything a renderer needs*: a `FilterGroup` was a flat list joined
by one operator, and overlap is irreducibly mixed AND and OR. So the compiler
learned to nest.

That is the outcome the bet is supposed to produce. A renderer finding a gap in
the query layer and the query layer growing to close it is the system working;
a renderer writing its own SQL around the gap is the system failing. The
difference is whether the next renderer inherits the fix.

**A task with one date is one day, not a bar to the horizon.** "Starts on the
4th, no deadline" is not "runs from the 4th to the end of the month", and
drawing the second invents a date nobody set. The open end is marked instead, so
the bar fades rather than stopping at an edge that would read as a deadline.

**A task with neither date is not on a timeline**, which the third clause says
explicitly rather than leaving to the accident that both other clauses pass.

*In one sentence:* the timeline needed the compiler to learn one thing, and
learning it is cheaper than any renderer working around it.

### D-079
**The shell is a component, extracted at the sixth copy** · 2026-09-07 · active

`AppShell`, `FooterNote` and `LoadFailure` in `components/app-shell.tsx`. The
five renderer pages each carried their own sidebar, header, breadcrumb, error
state and footer — around sixty lines apiece.

**It was flagged at three, ignored at four, and by then it had already gone
wrong.** The four copies were not identical. The list said "That filter link is
not valid" where the other three said "That link is not valid", and only the
list told you to start Docker and seed — the three screens most likely to be
opened from a shared link were the three that explained the failure worst. That
is what duplicated chrome does: it does not stay duplicated, it diverges along
whichever copy someone last touched.

**Three components, not one.** The pieces are not always used together. A task
detail page wants the sidebar and header but no view tabs and no filter bar; a
failure state wants none of it. One `<AppShell>` taking a dozen props to
express that would be the same duplication moved behind a props bag.

**The breadcrumb takes an override rather than a flag.** A renderer is looking
at a list, so the list is the leaf. A task is one level deeper, and it passes
what it is instead of setting `isTask` and letting the shell guess.

*In one sentence:* extracted the moment a sixth page needed it, and the four
copies had already drifted apart in exactly the way that argues for extracting
at three.

### D-080
**Authenticating is not authorizing, and every write does both** · 2026-09-07 · active

`requireTaskAccess`, `requireTasksAccess` and `requireListAccess` in
`@arbor/db`. Every server action that changes a task now calls one before it
writes.

**What was wrong.** Reads were permission-scoped from the beginning — every
view query joins `access_index` (ADR 3), so a task in a list you cannot reach
never reaches a screen. Writes were not. `cycleStatus`, `renameTask`,
`setPriority`, `archiveTask`, `moveTask` and `setTaskDate` each called
`requireUser` and then wrote. `requireUser` answers *who is asking*. Nothing
asked *whether they may*.

**Why it survived five phases.** It was unreachable in practice: the only way
to obtain a task id was to render a row, and rendering was scoped. The hole was
real and undemonstrable at the same time, which is the most durable kind. The
task detail page is what ends that — an id in a URL is something a person can
type — so this had to land before the page did, not after.

**`undo` was the worst of them.** It takes an `Operation[]` *from the client*
and applies it. Every other action derives its target from a task the caller
named; undo accepts a whole batch naming anything. Reverting the fix and
re-running `check:actions` renames a task in a private list to "Undone into",
which is the entire exploit in one line.

**Two refusals, not one.** Unreachable is reported as *gone*, in the same words
as a task that never existed — otherwise the check is an existence oracle and a
stranger can enumerate the workspace one id at a time. Reachable-but-
insufficient says what it is: the viewer is looking at the row, so there is
nothing left to conceal, and "it does not exist" would be a lie about something
on their screen. A smoke check asserts the first two messages are identical and
the third differs.

**In `@arbor/db`, not in the web app.** The worker will apply operations too
(that is what an automation action is), and a check that lives beside one
caller is a check the next caller does not have — the same argument that put
`applyOperations` there.

**A batch is refused whole.** Applying the reachable half of an undo would
half-restore a task, and the difference between "some of it worked" and "none
of it did" would tell the caller which ids were real.

**The seed now puts a task in the private list.** It had none, so the demo's
one private container proved nothing: the index could have been right and there
was still no row a broken check could wrongly return. That is the same failure
as the seed writing "everyone can manage everything" by hand, one level down.

*In one sentence:* knowing who someone is was never the same as knowing what
they may touch, and the detail panel is what turns that from a latent hole into
a reachable one.

### D-081
**Configuration is administered; a view is authorized as two things** · 2026-09-07 · active

`requireWorkspaceRole` guards sharing and every configuration action;
`requireViewAccess` guards saved views. With D-080, no server action in the app
now authenticates without also authorizing.

**D-080 was not a fix until this landed.** `shareContainerAction` took a
container id and a permission from any signed-in user and wrote a grant. So the
task check could be walked around in one extra request: grant yourself `manage`
on the private space, then edit the task legitimately. `check:actions` performs
exactly that sequence, and reverting this commit makes it succeed — the task is
renamed to "Renamed after granting myself access". A gate beside an open door
is not a gate.

**Why a workspace role and not a container permission.** The honest rule is
"you may share a container if you can manage it", and it cannot be written
today: `access_index` is keyed on *lists*, because `resolveAccess` emits one row
per reachable list by design (ADR 3), and a grant may target a space or a
folder. There is no fact in the system that answers "may this person manage the
space Founders". Inventing one inside a commit about something else is how a
permission model acquires a rule nobody decided, so the boundary is the
workspace role until the rule exists. Blunt and closed beats precise and open.

**What that costs, stated plainly.** A team lead who makes a private space
cannot share it without being a workspace admin. That is wrong, and it is wrong
in the safe direction. The fix is to extend `resolveAccess` to emit container
permissions alongside list rows, which is a change to the pure rule and its 30
tests — worth doing deliberately, not as a side effect.

**A view is two different objects.** A personal view is one person's: nobody
else may rename, redefine or delete it, *including an admin*, because a
personal view is invisible to everyone else and a control that edits what it
cannot see is not one anyone can reason about. A shared view is part of its
container and takes that container's `edit`. `requireViewAccess` decides which
by looking at `ownerId`, so no action has to remember the distinction — and
because it returns the actor config the services need, an action cannot obtain
its argument without having been checked.

**Fifteen actions, one line.** Every configuration action already went through
one `context()` helper, so the check went there. That is what a chokepoint is
for, and it is the difference between adding one check and remembering fifteen.

**The settings screen says so before it refuses.** A member sees a banner rather
than fifteen controls that look live and fail on click — the same rule as the
table headers that explain why they cannot sort (D-065).

*In one sentence:* the task check only became true once the action that could
hand out permissions was closed, and closing it needed a boundary that exists
rather than the one that should.

### D-082
**A task is a page, and the key is what opens it** · 2026-09-07 · active

`/t/ENG-402`, resolved as a key first and an id second. A full page, not an
overlay, and every renderer links to it.

**The address is the expensive half of D-031; the overlay is not.** D-031 chose
a route over a modal so that back, deep links and cached list state work. The
part that is costly to change later is what the URL says — links get pasted
into messages and outlive any layout. Whether the panel renders *over* a list
is a rendering choice that can change any week. So the address landed first and
in full, and the overlay did not.

**Why the overlay is not here yet, concretely.** Rendering beside a mounted
list is a parallel route plus an interception in Next, and interception only
catches navigations within the same segment tree. The five renderers sit at
five different roots (`/`, `/board`, `/table`, `/calendar`, `/gantt`), so it
would need writing five times, or the renderers need to move into one route
group first. That refactor is worth doing on its own terms rather than
underneath a feature.

**Key first, id second.** `tasks.key` is nullable — a task outside a space with
a prefix has none, and the two seeded subtasks are exactly that — so a
key-only route would leave rows unaddressable. One segment resolves both, which
is why the subtask links in the table read `/t/<uuid>` and work.

**There is no compiler call, and that is not a hole in D-032.** A view compiles
*which rows*; this page already knows the row. What it cannot skip is the thing
the compiler was silently providing on every other screen — the `access_index`
join — so `loadTask` does it, and returns null for a task the viewer cannot
reach. Everything else is borrowed rather than rewritten: `fieldsAvailableOn`
decides which custom fields appear, `resolveStatusSetFor` decides which statuses
it can move between. A detail page inventing either would be a second answer to
a question that already had one.

**The key is the permalink, not the name.** Clicking a name already means
rename on the list and the table, and a card is draggable on the board, so the
name cannot become a link on three of the five renderers without taking a
gesture away. The key is the identifier that exists to be cited, so it is what
opens the task. On the calendar and the timeline nothing claims that click, and
the name itself is the link — the calendar chip became an `<a>` that is still
draggable, since an anchor drags natively and the drop handler reads
`text/arbor-task` rather than the URL the browser also attaches.

**Controls, or values — never disabled controls.** A viewer without `edit` gets
the values as text. A disabled select still reads as something that would work
if you tried harder. Eleven custom field types have one obvious control and are
editable; the rest render as values with a `title` saying why, which is the
same rule as the table headers that cannot sort (D-065). The server decides
which are which, so the component cannot disagree with the page it was built
from.

**Status picks rather than cycles here.** A row has one control's worth of
space, so one click has to advance. A page has room for the whole set. Both
emit the same `setField`, so undo, the activity row and the inverse are shared
and only the gesture differs — and `setTaskStatus` checks the status belongs to
the set the list resolves, or a task could be moved into another space's status
and vanish from its own board.

**Assigning cost four lines.** `RelationOp` has been in the operation union
since Phase 3 and the executor has handled it since; nothing had ever called it
because no screen could assign anyone. The action builds one operation and
inherits the activity row and a working undo. That is the operation layer
paying for itself three phases after it was built.

*In one sentence:* the address is what had to be right, everything under it was
already built, and the parts that were not — a compiler call, a second status
rule, a second field-scoping rule — are the parts this page deliberately does
not have.

### D-083
**A comment is an operation, and its body is a document** · 2026-09-07 · active

`createComment`, `deleteComment`, `restoreComment`, `editComment` and
`setDescription` joined the `Operation` union. Bodies are a block tree —
paragraphs of text and mention nodes — stored in `jsonb`.

**Why an operation and not a comment service.** A service with its own INSERT
would have been shorter and would have made `applyOperations` no longer the
only thing that writes. That property is what has kept the activity log
complete by construction for five phases, and undo working without any feature
doing anything for it. The second writer is always the one that forgets to log.
Building comments the short way would have made the argument for the operation
layer retrospectively false.

**The cost, which is real: ⌘Z removes a comment you just posted.** That
surprises people the first time. It is also true — it *was* the last thing you
did — and the alternative was an undo stack that silently skips a whole class
of action, which is worse because nothing announces it.

**The description came along for the same reason.** It was going to be a direct
`UPDATE` in the web app, which would have been the second writer arriving
through the back door in the same commit that argued against one. It is a
`setDescription` operation instead, so it has an activity row and an inverse.

**Why the body is a tree and not a string.** A comment box is a textarea and a
string round-trips through `jsonb` perfectly well. The reason not to is
mentions: a mention is a *reference to a person*, and stored as the characters
"@Riley Kaur" the reference is gone. Renaming Riley rewrites history, two Rileys
are indistinguishable, and notification fan-out — the next pass — has to
re-parse prose to find out who was named. A node with an id costs nothing today
and cannot be retrofitted later without a migration over every comment ever
written. That is the whole argument for choosing the format before anything
needed it.

**The label is stored beside the id, duplicating the name on purpose.** It is
what the comment said at the time. Re-resolving every mention through the
current user table at render would rewrite what people wrote whenever someone
changes their name, and a mention of a departed user would come back blank.

**A textarea, still.** `parseRichText` turns typed text plus the list of people
who could be meant into the tree, and `renderPlain` turns it back. No editor, no
contenteditable, no dependency. The picker inserts the *full name* rather than a
token only the client understands, so what is typed is exactly what the server
parses. When Phase 9 brings a collaborative editor for Docs, it adopts this
shape rather than replacing it — one format to migrate, not two.

**Longest-name matching, and ambiguity left unresolved.** Names contain spaces,
so "@Riley Kaur" has to beat "@Riley". Two people with the same name resolve to
neither: picking one would notify the wrong person with nothing on screen saying
so, and a mention that visibly did not resolve is better than one that silently
resolved wrong.

**Stored JSON is untrusted input, including our own.** `parseStoredDoc`
validates on read and returns null rather than throwing, so one malformed row
renders as an unreadable comment instead of taking the page down. Same rule as a
view definition going through the compiler rather than being trusted for having
come from the database (D-018).

**Deleting is soft and the tombstone stays when it has replies.** A deleted
comment that answered nothing is dropped; one with replies under it remains as
"This comment was deleted", because removing it would leave a conversation whose
first half is missing. One level of replies, enforced in the executor: a thread
that nests forever is a rendering problem with no natural bottom.

**Editing is the author's alone.** Someone with `edit` on the list may change
this task in every way the panel offers and still may not rewrite what another
person said — a comment records that a person said a thing, and an edit by
anyone else makes the record false. Checked *as well as* list access, not
instead of it: an author who has lost access to the list has lost it.

*In one sentence:* the parts of a comment that are expensive to change later —
that it is an operation, and that its body is a reference-carrying tree — were
both decided before the first one was written.

### D-084
**A mention may grant access, but never quietly** · 2026-09-07 · active

Mentioning someone who cannot see the task refuses the post, names them, and
says exactly what posting again would grant. Only then does it grant.

**The three ways this could have gone, and why this one.** A picker scoped to
people who already have access is safest and silently unhelpful — on a private
list it shows a short list and never explains who is missing. Silent auto-share
is what most tools do and makes a comment box a permission-granting control,
which is a large thing to hide behind an "@". This is the third: the same
outcome as auto-share, with the moment made visible.

**Three problems it removes, not one.** The grant lands on the **list** rather
than the space, so mentioning someone on one task does not open every other list
in a private space. It requires the author to hold `manage` (D-081) — a member
who cannot share is told so rather than being handed the power by a side effect.
And the index rebuild that every grant triggers (D-071) happens on an explicit
confirmation rather than inside the transaction of every comment that happens to
name a new person.

**The text is kept while the question is on screen.** Being asked a question is
not a reason to retype a paragraph.

**What is asserted, and why that shape.** `check:actions` posts the mention
without consent and then checks that *neither* the comment nor the grant was
written — an assertion about what did not happen, because "the comment posted
and also silently shared a private list" would otherwise look exactly like
success.

*In one sentence:* the behaviour people expect from a mention is worth having,
and the only version worth shipping is the one where nobody is surprised by what
it did.

### D-085
**The shell fetches the badge; nobody hands it one** · 2026-09-07 · active

The sidebar calls `unreadCount` for itself inside `AppShell`, rather than
receiving the number through `ShellChrome` from whichever page is rendering.

**Why not a prop.** There are seven screens and one `chromeFrom`, and a count
threaded through it is seven call sites that each have to remember to fetch it.
That is precisely the drift D-079 extracted this file to end: the four sidebars
it replaced had already diverged, and the divergence nobody noticed was the
quiet one. A badge that is right on four screens and stale on three is worse
than no badge, because it is only wrong where nobody is looking.

**The cost is one indexed count per page render**, and it is cheap for the same
reason the fan-out is: the query is scoped by `user_id` and joins the index
every other read joins. `inboxBadge` wraps it in React's `cache`, so the inbox
page — the one screen that wants the number twice, once for the sidebar and once
for its own header — pays for it once.

**It returns null rather than throwing.** This runs inside the chrome of every
screen, and every page already has a considered answer for an unreachable
database (D-042). A count that cannot be taken must not be the thing that turns
a working page into a stack trace.

*In one sentence:* the badge belongs to the chrome, so the chrome is what knows
how to get it.

### D-086
**A screen may be nowhere in the tree** · 2026-09-07 · active

`ShellChrome.location` is optional, and holds the space, folder, list and task
count together in one object rather than as four sibling fields.

The inbox is the first screen that is not looking at one container — "what is
mine, anywhere" has no list to name — and the shell assumed there was always
one. Two ways to say so: make each field optional, or group them. Grouped,
because they are only ever true together, and "a folder name with no list" is
not a state worth being able to express. The breadcrumb and the Spaces group
both key off the same absence, so a screen with no location cannot end up with
half a trail.

A screen with no location also has no way back — every other entry in that
sidebar is still a placeholder — so it gets the "Back to work" entry settings
already uses. The two container-less screens now say the same thing in the same
place, which is the whole point of there being one shell.

*In one sentence:* the type says which screens are in the tree, so the shell
cannot render a breadcrumb to a list that is not there.

### D-087
**Read state is not the workspace, so it is not an operation** · 2026-09-07 · active

`markRead` and `markAllRead` write directly, not through `applyOperations`.

**The invariant they appear to break.** Every mutation is an operation (D-049),
which is what makes the activity log complete and undo free. A second writer is
the one that forgets to log (D-083), so an exception needs an argument rather
than a convenience.

**The argument.** The rule covers the workspace — the shared thing people are
looking at. Read state is one person's view of it: nobody else can observe it,
"Avery marked a notification read" is noise in a log meant to answer what
happened to the *work*, and ⌘Z restoring a bold row is not a feature anyone
wants. Sessions already write outside the executor for the same reason, and
nobody has ever wanted to undo a sign-in.

**Authorization by scoping rather than by refusal.** Both queries carry
`AND user_id = $1`, so someone else's id updates zero rows instead of being
refused. That is deliberate: an inbox that answers "that is not yours" has
confirmed the id exists, which is the leak D-080 is about. The action still
validates the id's shape first, because `invalid input syntax for type uuid` is
not a sentence to show anyone.

*In one sentence:* the executor exists to keep the record of the work honest,
and what you have read is not part of the work.

### D-088
**A mark on the feed, not a flag on every event** · 2026-09-08 · active

The ambient half of the inbox — activity on tasks you watch — has one
`activity_seen_at` timestamp per membership. It does not have a read flag per
event.

**Because the alternative undoes the reason the design exists.** The whole point
of aggregating at read time is that a task with two hundred watchers costs zero
writes when it changes (the schema's own rule). Giving each watcher a read flag
on each event puts those two hundred rows straight back, with a different column
name on them. The direct half can afford a flag per row precisely because it is
small and addressed: `notifications` only ever holds what named you.

**On `memberships`, not on `users` and not in a table of its own.** It has
exactly the membership's key and lifetime — someone who is not in the workspace
has no inbox in it — which makes it an update rather than an upsert, with no
row that might not exist. `users.preferences` was the tempting no-migration
option and is wrong: this is state, not a preference, and burying it in a blob
means nothing can index or reason about it later.

**Null means a week, not all of history.** A first visit has no mark to measure
from, and opening the inbox on everything that ever happened to twelve watched
tasks is not a screen anyone reads. The same reasoning caps the window at
fourteen days: the feed is derived from a log that only grows, so it needs a
floor that the direct half — where a row stays until it is cleared — does not.

**What it costs.** Read state is all-or-nothing: you cannot dismiss one task's
activity and keep another's. That is honest for a feed and reads as "caught up
to here", but it is a real limit, and per-task dismissal would be a table of
what you have dismissed rather than a flag on what happened.

*In one sentence:* the read side was allowed to write exactly one row per
person, and that is enough to answer "what is new".

### D-089
**One stream, two halves** · 2026-09-08 · active

The inbox is a single list sorted by time, holding both the signals written for
you and the activity assembled from what you watch — not two sections, and not
two tabs.

**Because the question is "what happened while I was away"**, and it has one
answer in one order. Two sections make the reader do the merge themselves, and
they make the ordering meaningless across the boundary: the thing at the top of
the second list may be older than everything in the first.

**The halves behave differently and the row says so, in two places only.** A
signal offers "Mark read"; an aggregate says "3 changes" instead, because there
is no single row to mark (D-088). A signal's glyph is filled, an aggregate's is
outlined. Everything else — the summary, the task, the time, the click — is the
same, which is what makes it one list rather than two lists drawn in one column.
The seam is carried by two fields on one flat type: `source` and
`notificationId`.

**The badge counts signals only.** A number that also counted every task
somebody touched would be large, mostly ignorable, and therefore ignored — and
a badge people ignore is worse than no badge. Being assigned something is a
demand on you; a task you watch moving is not. So the sidebar counts the first,
and the inbox's own header names both: "1 unread · 4 watching".

**"Mark all read" clears both**, by two mechanisms that the reader never has to
know about: a flag per row for the signals, one timestamp for the feed. A button
that says "all" and empties half of itself is worse than two buttons.

*In one sentence:* the split between the halves is a fact about how they are
stored, and storage is not a reason to make somebody read two lists.

### D-090
**A nudge over Postgres, not a delta over Redis** · 2026-09-08 · active

Live updates are Server-Sent Events from a Next route handler, carrying
`{workspace, list, actor}` and nothing else. The browser answers by calling
`router.refresh()`.

**Three transports were on the table** (the README names the third). Doing
nothing but `revalidatePath` is what shipped until now: correct, and not live.
A real `apps/realtime` with Redis pub/sub is a second deployable, a second
dependency and a second place for auth to be wrong — bought before anything
needed it. SSE over `LISTEN`/`NOTIFY` needs neither, and the traffic is
one-directional: the server says something changed, the browser says nothing
back. `EventSource` reconnects on its own, which is the entire body of code a
WebSocket would have made us write. A socket becomes worth it when the browser
has something to send, and that is presence.

**Announced inside the transaction, and that is the whole trick.** `NOTIFY` is
transactional — Postgres delivers at commit and discards on rollback. So a nudge
cannot describe a change that did not happen, and this needs no after-commit
hook, no outbox table and no worker: the three things that make "publish after
write" hard everywhere else. It sits in `logActivity` for the reason that
function exists, that every operation already passes through it, so a new
operation cannot forget to broadcast any more than it can forget to log.

**The payload is deliberately identical for every operation in a batch.**
Postgres collapses duplicate notifications inside one transaction, so a bulk
edit of two hundred tasks in one list delivers one nudge rather than two
hundred, and nothing here deduplicates.

**A nudge, not a delta**, because the screens are server components. Re-running
the page *is* the update; sending the change itself would mean a second
description of every mutation, in a second shape, kept in step with the first by
hand. Deltas are what a CRDT editor needs, and Docs are Phase 9.

**Every nudge is checked against the viewer's access before it leaves.** The
channel carries every change in the process, because the transport has no idea
who is listening; the route handler does. Without that check the stream would
tell anyone with a session that *something* changed in a list they cannot open,
which is the existence leak the refusals are careful not to be (D-080). One
indexed lookup per nudge per viewer, uncached on purpose: a cache would have a
window in which a revoked person still hears about a list.

**What it cost to get right was not the transport.** The stream worked on the
first try; the screen still did not change, because a row holding
`useState(task.name)` had stopped listening to the server the moment it mounted
(`use-server-value.ts`). Live updates are what made that visible — every check
in the repo passed while the screen showed a stale name.

*In one sentence:* the database everything already talks to has a transactional
pub/sub in it, and using it made "live" a route handler and a hook rather than a
service.
