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
> Docs, chat, automations and AI are not.
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
npm test               # 420 unit tests, no database needed
npm run db:smoke       # 199 checks against real Postgres: compiled queries,
                       # permission scoping, mutations, and the activity log
npm run check:actions  # 140 checks that POST what a button click posts, then
                       # assert against Postgres — needs a dev server running
```

The three run at different depths on purpose. Unit tests cover logic with no
fixtures; `db:smoke` proves the SQL the compiler emits is valid and that
permission scoping actually filters rows; `check:actions` covers the seam
between a UI handler and a service, which is where the bugs that survived
longest have lived.

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
  web/          Next.js — UI and server actions
  realtime/     ·  WebSocket gateway, presence, Yjs sync
  worker/       ·  automations, digests, access-index rebuilds
packages/
  core/         view compiler, field types, status rules, ordering — no I/O
  db/           Drizzle schema, migrations, seed, configuration services
  ui/           design tokens
  sdk/          ·  typed API client
infra/
  docker/       compose.yml — the self-host path
  terraform/    ·  the AWS reference deployment
docs/decisions/ ADRs
```

**`·` marks a directory that is empty**, and one of them is now empty on
purpose rather than pending. `realtime` was going to be a WebSocket gateway;
Postgres turned out to carry it — changes ride `LISTEN`/`NOTIFY` announced
inside the transaction that made them, presence *is* the open connection, and
both cross process boundaries on the same channel. There is nothing left for a
second deployable to do. `worker` still earns its keep once there are
automations to run, and `sdk` once there is an API worth a typed client. The
AWS topology below is designed and documented; no Terraform is written.

`packages/core` holds the things hardest to get right — the view compiler, the
field type system, status resolution, ordering, and the document format
comments and descriptions are stored in. It has no database handle and no
request object, which is why its tests need no fixtures and why it is the
easiest part of the codebase for a stranger to contribute to.

---

## Deployment

Designed to run on AWS, and to run anywhere Docker does. Nothing sits on a
third-party application platform, hosted database vendor, or auth SaaS.

*Today only the Docker path exists* — the table below is the reference design,
not a deployment you can `terraform apply` yet.

| | AWS (reference) | Google Cloud | Self-host |
| --- | --- | --- | --- |
| Containers | ECS Fargate + ALB | Cloud Run | Docker Compose |
| Database | RDS Postgres | Cloud SQL | postgres:17 |
| Cache / pub-sub | ElastiCache Redis | Memorystore | redis:7 |
| Live updates | *(Postgres `LISTEN`/`NOTIFY`)* | *(the same)* | *(the same)* |
| Object storage | S3 + CloudFront | Cloud Storage | MinIO |
| Queue | SQS | Pub/Sub | Redis-backed |
| Email | SES | SMTP | Mailpit |
| LLM | Bedrock | Vertex AI | Direct API key |

Two rules keep that table true: use the **S3 API** rather than S3-specific
features, and put every managed service behind a small interface with the local
implementation written first. If Compose can run the test suite, the abstraction
is real.

Fargate rather than Lambda, deliberately — Server-Sent Events need long-lived
connections, which a per-invocation runtime cannot hold open.

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
- [ ] **9 — Docs.** CRDT editor, nested pages, backlinks.
- [ ] **10 — Automations, forms, public API.**

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

[AGPL-3.0-only](LICENSE). The client SDK in `packages/sdk` is Apache-2.0 so it
can be embedded freely.
