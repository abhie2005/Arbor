# Arbor

A dense, keyboard-driven work platform. Hierarchies, saved views, custom fields,
and real-time collaboration — self-hostable, and open source under AGPL-3.0.

> **Status: early, but real.** The container tree, task model, view compiler,
> permission index, mutation layer, and the configuration engines all work and
> are tested against a real Postgres. Five renderers — List, Board, Table,
> Calendar and Timeline — read through the same compiler, with a filter bar,
> sortable columns and working undo. Every row opens a task detail page with
> comments, mentions, threaded replies and its own history. Screens are live,
> and presence is the connection itself rather than a second service. Sign-in,
> private containers and sharing are real, and every write is
> permission-checked. Time tracking, goals and dashboards are built — a goal's
> rollup and a dashboard card are compiled by the same thing that compiles a
> list, so a number on one screen cannot disagree with the rows on another.
> Documents are built and editable — a page's body is a CRDT holding the same
> block tree comments use, and ⌘Z inside one takes back your own typing without
> ever reaching a colleague's. Search reads across tasks and pages, scoped by
> the same permission join everything else uses. Automations run and have a
> screen: a rule is a trigger, the filter bar's own conditions and actions that
> compile to the same operations a person's click does, it acts as a service
> account the permission model already knows, and a delayed rule asks its
> conditions when it acts rather than when it was queued. Forms, a public API,
> chat and AI are not built. The AWS deployment (Terraform and a container
> image) has been applied to a real account once and destroyed again.
> **[docs/STATUS.md](docs/STATUS.md) is the current state and where to pick up.**

---

## Quickstart

```bash
git clone https://github.com/abhie2005/Arbor.git
cd Arbor
cp .env.example .env

npm install
npm run docker:up      # postgres, redis, minio, mailpit
npm run db:migrate
npm run db:seed        # a populated demo workspace, not an empty shell
npm run dev
```

Requires Node 22+ and Docker. Nothing else, and no cloud account — sign-in is
part of the app rather than a service you register for. The seed prints the
demo password.

Verify the stack end to end:

```bash
npm test               # 582 unit tests, no database needed
npm run db:smoke       # 278 checks against real Postgres: compiled queries,
                       # permission scoping, mutations, the activity log, and
                       # the automation engine end to end
npm run check:actions  # 162 checks that POST what a button click posts, then
                       # assert against Postgres — needs a dev server running
npm run check:search   # 11 GETs against /search, asserting what the screen
                       # renders — runs against a dev server, the container
                       # image, or a deployed URL
```

They run at different depths on purpose. Unit tests cover logic with no
fixtures; `db:smoke` proves the SQL the compiler emits is valid and that
permission scoping actually filters rows; `check:actions` covers the seam
between a UI handler and a service, which is where the bugs that survived
longest have lived; `check:search` covers a screen that has no server action at
all, so none of `check:actions`' machinery applies to it (D-115) — and unlike
the others it will run against a deployed environment, because all it needs is
a URL and the seeded workspace.

---

## What it is

Underneath, this is one object graph — containers holding work items — and four
configuration engines that let each team reshape it into their own workflow
without writing code.

| Engine | What it does |
| --- | --- |
| **Views** | A view is a saved query plus a renderer. Every view type serializes to the same definition, so a board is just `grouping.field = "status"`, a table is the same query showing the definition's own `columns`, and a timeline is that query scoped to what overlaps a window. Five renderers, no view-specific SQL — and the same definition is what a goal's rollup and a dashboard card are stored as, so the compiler answers "which tasks count" once for the whole product instead of once per feature. |
| **Statuses** | User-named statuses that each belong to a fixed group (`not_started`, `active`, `done`, `closed`). Everything else — filters, reporting, burndown — keys off the group, never the name. |
| **Fields** | Custom fields defined on any container, optionally scoped to a task type, stored in a typed EAV table so filtering and sorting stay on an index. Twenty types, each declaring its own storage column, legal operators, and config schema — the filter bar builds its menus from the same declaration the query compiler validates against. |
| **Permissions** | Grants are the source of truth; a materialized access index is what queries actually join against, so permission checks cost one join instead of one per level of nesting. The rule that flattens one into the other is a pure function, tested without a database. Reads and writes both go through it. |

The [architecture teardown](docs/) covers the reasoning in full.

---

## Layout

```
apps/
  web/          Next.js — UI, server actions, and the automation drain
packages/
  core/         view compiler, field types, status rules, ordering,
                the document format, the rule engine — no I/O
  db/           Drizzle schema, migrations, seed, configuration services
  ui/           design tokens
infra/
  docker/       compose.yml — the self-host path
  terraform/    VPC, RDS, ECS Fargate, ALB, ECR — 45 resources
Dockerfile      two targets: the app, and a one-off migration task
docs/decisions/ ADRs
```

**That is the whole of it — one app and three packages.** Earlier versions of
this file listed `apps/realtime`, `apps/worker` and `packages/sdk` as empty
directories waiting to be filled. They are not empty; they were never created,
and two of the three are no longer wanted:

- **`realtime` was going to be a WebSocket gateway.** Postgres carried it
  instead — changes ride `LISTEN`/`NOTIFY` announced inside the transaction
  that made them, presence *is* the open connection, and both cross process
  boundaries on the same channel. There is nothing left for a second deployable
  to do.
- **`worker` was going to run the automations.** They run, and the queue is a
  table: a rule due in three days is a row with `run_after` three days out, and
  the drain is a loop in the web process that claims work with
  `FOR UPDATE SKIP LOCKED`. Nothing in the engine knows which process drains
  it, so moving that loop into a worker service is a deployment decision later
  rather than a rewrite — and the app still reads three environment variables
  instead of growing a fourth (D-125).
- **`sdk` waits on the public API**, which is the half of phase 10 that has
  nothing built against it yet.

`packages/core` holds the things hardest to get right — the view compiler, the
field type system, status resolution, ordering, and the document format
comments and descriptions are stored in. It has no database handle and no
request object, which is why its tests need no fixtures and why it is the
easiest part of the codebase for a stranger to contribute to.

---

## Deployment

Designed to run on AWS, and to run anywhere Docker does. Nothing sits on a
third-party application platform, hosted database vendor, or auth SaaS.

*The AWS column is now partly real.* `infra/terraform/` provisions a VPC, RDS
Postgres, an ECS Fargate service behind an ALB, and the two ECR repositories the
`Dockerfile`'s two targets push to — 45 resources, with a runbook in
`infra/terraform/README.md`. **It has been applied**: all 45 stood up in a real
account, the schema migrated, the app answered its health check through the
load balancer, and it was destroyed again, for about fifteen cents. The apply
was worth running because it falsified a sentence in these docs — `sslmode=require`
had stopped meaning "encrypted but unverified" and started meaning "fails", so
the images now ship the Amazon RDS CA bundle and verify properly (D-118). The rows marked *(designed for)*
below are still design: no S3, SES, SQS, ElastiCache or Bedrock is provisioned,
because nothing in the application asks for them yet (D-114).

| | AWS | Google Cloud | Self-host |
| --- | --- | --- | --- |
| Containers | ECS Fargate + ALB — **built** | Cloud Run | Docker Compose |
| Database | RDS Postgres — **built** | Cloud SQL | postgres:17 |
| Image registry | ECR — **built** | Artifact Registry | *(local build)* |
| Secrets | Secrets Manager — **built** | Secret Manager | `.env` |
| Live updates | *(Postgres `LISTEN`/`NOTIFY`)* | *(the same)* | *(the same)* |
| Cache / pub-sub | ElastiCache Redis *(designed for)* | Memorystore | redis:7 |
| Object storage | S3 + CloudFront *(designed for)* | Cloud Storage | MinIO |
| Queue | SQS *(designed for)* | Pub/Sub | Redis-backed |
| Email | SES *(designed for)* | SMTP | Mailpit |
| LLM | Bedrock *(designed for)* | Vertex AI | Direct API key |

Two rules keep that table true: use the **S3 API** rather than S3-specific
features, and put every managed service behind a small interface with the local
implementation written first. If Compose can run the test suite, the abstraction
is real.

Fargate rather than Lambda, deliberately — Server-Sent Events need long-lived
connections, which a per-invocation runtime cannot hold open. That choice bills
twice: the load balancer's 60-second idle timeout closes exactly those streams,
and its 300-second deregistration delay waits for connections designed never to
close, so both are set explicitly rather than defaulted (D-114).

Redis is in the table and nothing uses it yet. Live updates and presence went to
Postgres instead, because the database every request already talks to has a
transactional pub/sub, and a nudge that could describe a change which was rolled
back would be worse than no nudge.

---

## Roadmap

- [x] **1 — Foundation.** Container tree with arbitrary depth, tasks and
      subtasks, multi-list membership, fractional ordering, soft delete.
- [x] **2 — View compiler.** Definition object, permission-scoped SQL
      compilation, filters, grouping, custom-field sorting, group counts.
- [x] **3 — Mutations.** Invertible operations, one transaction per batch, an
      activity row per change, real undo, and an interactive List view.
- [x] **4 — Configuration engines.** Status sets with inheritance and task
      migration on delete, twenty custom field types with per-type validation,
      task types with field scoping, workflow templates, and a settings screen.
- [x] **5 — Access control.** Private containers, grants, group grants, role
      baselines, the access-index rebuild and a sharing screen — plus real
      sign-in: scrypt password hashes, server-side sessions, and a login
      screen. Account creation and password reset are not built.
- [x] **6 — Views.** Saved-view CRUD, and Table, Calendar and Timeline over the
      compiler that already served List and Board. The timeline is the one that
      made the compiler learn something: nested filter clauses, because
      "overlaps this window" is mixed AND and OR.
- [x] **7 — Collaboration.** Comments, mentions, the task detail page, its
      history and the inbox; every write is authorized, not merely
      authenticated. Notifications have both halves: direct signals — assigned,
      mentioned, replied — written inside the transaction that caused them, and
      activity on what you watch aggregated at read time, so watching something
      costs no writes. Screens are live over SSE and Postgres `LISTEN`/`NOTIFY`,
      and presence is the stream itself — no second service, no Redis, no
      heartbeat.
- [x] **8 — Depth.** Time tracking, goals and dashboards, all three on tables
      that had been migrated since day one and never written to. Tracked time is
      an operation like everything else, so undo and the activity log came free;
      a goal's key result stores a view definition rather than a query language
      of its own; a dashboard card's *kind* is which compiler entry point it
      calls. Whose permissions a number is computed with turned out to be a
      decision rather than a default — a goal's rollup runs as the goal's owner,
      so a shared commitment reads the same for everyone, and a dashboard card
      runs as the viewer, because a dashboard lives in a container.
- [x] **9 — Docs.** CRDT editor, nested pages, backlinks. The editor and the
      page tree are built; so is **search**, which was the first reader the
      documents' plain-text projection ever had. Both halves of search match the
      same way the view compiler always has — case-insensitive substring — so one
      box cannot have two ideas of what matches, and neither half needed a
      permission rule of its own: tasks go through the compiler's access-index
      join, pages through the clause the docs screen already shares. ⌘Z inside a
      document is the CRDT's rather than the browser's, and tracks only local
      edits, so undo can never take back somebody else's sentence. The editor
      is a hand-rolled contenteditable per paragraph, because every Yjs editor
      binding binds a shared type the stored format is not — and a mention is
      one character in the string it edits, which is what makes a DOM offset, a
      caret and a CRDT position the same number. The page tree computes its
      order from the tree rather than the flat list it arrives as — which was
      the real bug behind "only indentation" — and a drop onto a row or into
      the gap below one is the same call with a different `afterId`. `[[`
      links a page or a task: one more embed kind in the same format, which
      the editor's offset arithmetic absorbed without a change, plus an edge
      table so the reverse question has an index to answer it.
- [ ] **10 — Automations, forms, public API.** Automations are built and have a
      screen; forms and the API do not exist yet. The engine reuses three
      vocabularies rather than inventing any: a trigger names its verb by
      calling the same function that *writes* the activity log, so a rename
      drags every rule along with it instead of quietly unhooking them;
      conditions are a `FilterGroup` evaluated by the view compiler, so custom
      fields and nested AND/OR arrive for free and a rule cannot disagree with
      a saved view about what "overdue and unassigned" means; and an action
      compiles to an `Operation`, so the activity row comes free and the answer
      to "whose undo stack does a robot's write land in" is nobody's, by
      construction. The queue is a table and a delay is a column on the rule —
      "in 3 days, if still open" works because the conditions are asked when
      the run executes rather than when it was queued. A rule acts as a
      per-workspace service account: a real member the access index knows, not
      a synthetic id, which is what lets history name it and permission checks
      treat it like anybody else. `/settings/automations` writes one out of
      parts that already existed — the sharing screen's container tree, the
      filter bar's condition menus — and takes `manage` on the container a rule
      is scoped to rather than a workspace role.

Access control moved ahead of collaboration deliberately: every collaborative
feature fans out to *whoever can see a thing*, and building that fan-out on a
development stub means rewriting it once permissions are real.

---

## Contributing

Good first issues are the ones shaped like this: a new view renderer, a new
custom field type, a keyboard shortcut. Each is self-contained, visible, and
satisfying.

There is a worked example of each. The Board, Table, Calendar and Timeline
renderers (`apps/web/src/app/board/`, `table/`, `calendar/`, `gantt/`) are
complete renderers over the shared compiler, and between them they needed no
view-specific SQL — so another one is the same shape of work. A field type is one entry in
`FIELD_TYPE_META` plus a parser and a value control, and the compiler, the
mutation executor, and the filter menu all pick it up from there.

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. If you want to know why
something is the way it is, [DECISIONS.md](DECISIONS.md) logs every non-obvious
call with the alternatives that were rejected, and [docs/decisions/](docs/decisions/)
holds the ADRs for the structural ones.

UI primitives come from the [21st.dev](https://21st.dev) registry via the shadcn
CLI, land in `packages/ui/src/primitives/`, and are re-tokenized to Arbor's
density on import. Record every import in
[`packages/ui/ATTRIBUTIONS.md`](packages/ui/ATTRIBUTIONS.md).

## License

[AGPL-3.0-only](LICENSE). The client SDK will be Apache-2.0 when there is one,
so it can be embedded freely — `packages/sdk` does not exist yet and waits on
the public API.
