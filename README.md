# Arbor

A dense, keyboard-driven work platform. Hierarchies, saved views, custom fields,
and real-time collaboration — self-hostable, and open source under AGPL-3.0.

> **Status: early.** The container tree, task model, view compiler, permission
> index, and mutation layer all work and are tested against a real Postgres.
> The List view is interactive. Everything else is unbuilt.
> **[docs/STATUS.md](docs/STATUS.md) is the current state and where to pick up.**

---

## Quickstart

```bash
git clone https://github.com/<you>/arbor.git
cd arbor
cp .env.example .env

npm install
npm run docker:up      # postgres, redis, minio, mailpit
npm run db:migrate
npm run db:seed        # a populated demo workspace, not an empty shell
npm run dev
```

Requires Node 22+ and Docker. Nothing else, and no cloud account.

Verify the stack end to end:

```bash
npm test               # 80 unit tests, no database needed
npm run db:smoke       # 16 checks against real Postgres: compiled queries,
                       # permission scoping, mutations, and the activity log
```

---

## What it is

Underneath, this is one object graph — containers holding work items — and four
configuration engines that let each team reshape it into their own workflow
without writing code.

| Engine | What it does |
| --- | --- |
| **Views** | A view is a saved query plus a renderer. Every view type serializes to the same definition, so a board is just `grouping.field = "status"`. One compiler, many renderers. |
| **Statuses** | User-named statuses that each belong to a fixed group (`not_started`, `active`, `done`, `closed`). Everything else — filters, reporting, burndown — keys off the group, never the name. |
| **Fields** | Custom fields defined on any container, optionally scoped to a task type, stored in a typed EAV table so filtering and sorting stay on an index. |
| **Permissions** | Grants are the source of truth; a materialized access index is what queries actually join against, so permission checks cost one join instead of one per level of nesting. |

The [architecture teardown](docs/) covers the reasoning in full.

---

## Layout

```
apps/
  web/          Next.js — UI and API routes
  realtime/     WebSocket gateway, presence, Yjs document sync
  worker/       automations, digests, access-index rebuilds, scheduled jobs
packages/
  core/         view compiler, hierarchy resolution, ordering — framework-free
  db/           Drizzle schema, migrations, seed
  ui/           design tokens and interface primitives
  sdk/          typed API client (the web app uses it too)
infra/
  docker/       compose.yml — the self-host path
  terraform/    the AWS reference deployment
docs/decisions/ ADRs
```

`packages/core` holds the three things hardest to get right — the view compiler,
the permission resolver, and ordering. It has no database handle and no request
object, which keeps it honest and makes it the easiest part of the codebase for a
stranger to contribute to.

---

## Deployment

Runs on AWS, and runs anywhere Docker does. Nothing sits on a third-party
application platform, hosted database vendor, or auth SaaS.

| | AWS (reference) | Google Cloud | Self-host |
| --- | --- | --- | --- |
| Containers | ECS Fargate + ALB | Cloud Run | Docker Compose |
| Database | RDS Postgres | Cloud SQL | postgres:17 |
| Cache / pub-sub | ElastiCache Redis | Memorystore | redis:7 |
| Object storage | S3 + CloudFront | Cloud Storage | MinIO |
| Queue | SQS | Pub/Sub | Redis-backed |
| Email | SES | SMTP | Mailpit |
| LLM | Bedrock | Vertex AI | Direct API key |

Two rules keep that table true: use the **S3 API** rather than S3-specific
features, and put every managed service behind a small interface with the local
implementation written first. If Compose can run the test suite, the abstraction
is real.

Fargate rather than Lambda, deliberately — WebSockets need long-lived
connections, and API Gateway's WebSocket API bills per message.

---

## Roadmap

- [x] **1 — Foundation.** Container tree with arbitrary depth, tasks and
      subtasks, multi-list membership, fractional ordering, soft delete.
- [x] **2 — View compiler.** Definition object, permission-scoped SQL
      compilation, filters, grouping, custom-field sorting, group counts.
- [x] **3 — Mutations.** Invertible operations, one transaction per batch, an
      activity row per change, real undo, and an interactive List view.
- [ ] **4 — Configuration engines.** Status sets with inheritance, custom field
      CRUD, task types with field scoping, templates.
- [ ] **5 — Collaboration.** Comments, notifications, realtime deltas, presence.
- [ ] **6 — Access control.** Real auth, private containers, grants,
      access-index rebuild job, guests.
- [ ] **7 — Depth.** Time tracking, goals, dashboards, remaining view renderers.
- [ ] **8 — Docs.** CRDT editor, nested pages, backlinks.
- [ ] **9 — Automations, forms, public API.**

---

## Contributing

Good first issues are the ones shaped like this: a new view renderer, a new
custom field type, a keyboard shortcut. Each is self-contained, visible, and
satisfying.

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
