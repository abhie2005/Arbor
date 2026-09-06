# Status — resume here

Last updated 2026-09-05. Repo: https://github.com/abhie2005/Arbor (`main`).

This file exists so a new session, or a future you, can pick the project up
without re-deriving anything. Update it whenever you stop mid-stream.

---

## No open bugs

The undo bug that headed this file for two days is **fixed and verified**
(D-049). The root cause was not in either place the previous two fixes looked.

**What it was.** The server returns the *inverse* of what it applied (D-036),
because only the server knows the value a field held before the write. The
client's `UndoStack` was modelled the textbook way — store operations as
applied, invert them on pop. So the client pushed an inverse into a stack that
inverted it again, and undo re-applied the original change. The task was already
in that state, so the row did not move; `from` and `to` still differed, so it
was not filtered as a no-op and reported success. Hence "it says it undid, but
it didn't".

**Why every test passed.** Each layer was correct in isolation and tested in
isolation: `invert` has 24 unit tests, `db:smoke` inverts the forward operation
(the correct single inversion), and `UndoStack` had seven tests that all pushed
forward operations. The defect existed only in the seam between two layers, and
nothing crossed it.

**How it was found.** By sending the `undo` server action the exact request a
click sends, then checking Postgres. The write landed *and* the response carried
a refreshed payload — which eliminated both hypotheses this file had been
holding and left only what the client had put in the request.

That technique is now `npm run check:actions` (D-048), and it includes an undo
regression check. Reverting the fix makes three unit tests and two action checks
fail with the original symptom.

---

## Get running in 3 commands

```bash
colima start                                   # Docker daemon (Colima on this Mac)
docker start arbor-pg || docker run -d --name arbor-pg \
  -e POSTGRES_USER=arbor -e POSTGRES_PASSWORD=arbor -e POSTGRES_DB=arbor \
  -p 5432:5432 postgres:17-alpine
cd apps/web && npx next dev -p 3100
```

Then `http://localhost:3100`. **Port 3000 is usually taken by another project on
this machine** (`tempo`) — check before assuming a page you are looking at is
Arbor. First compile is around 6 seconds once `.next` exists; the "~5 minutes"
noted here previously was a cold cache.

Verify without the browser:

```bash
npm test                                       # 149 unit tests, no database needed
npm run db:seed && npm run db:smoke            # 45 checks against real Postgres
npm run check:actions                          # 13 checks — needs the dev server on 3100
```

`check:actions` is the only one that needs a running server: it POSTs to the
page with a `Next-Action` header, which is the request a button click makes.

---

## What works today

| Area | State |
|---|---|
| **Schema** | 43 tables, 9 enums, 116 indexes. Migrated (0000, 0001) and seeded. |
| **View compiler** | Definition → one parameterized SQL query. Filters, grouping, sorting, group counts, permission scoping. Custom fields resolve through a required field catalog. |
| **Hierarchy** | Config inheritance, effective privacy, denormalized ancestors, move-legality. |
| **Ordering** | Fractional indices — one row written per drag. |
| **Mutations** | Invertible operations, one transaction per batch, activity row per change. **Undo works.** |
| **List view** | Renders through the compiler. Status cycling, priority cycling, inline rename, archive, inline create, undo. |
| **Board view** | Same compiler, `grouping.field = status`. Drag between and within columns, one row written per drag, one undo entry per drag. |
| **Field types** | All 20 declared in one place: storage column, legal operators, config parser, value parser. |
| **Status sets** | CRUD, inheritance resolution, four templates, reordering, and task migration on delete. |
| **Custom fields** | CRUD, per-type config, placement down the tree, task-type scoping, archive, and type change with a real value migration. |
| **Task types** | CRUD, one default per workspace, deletion with reassignment. |
| **Settings UI** | `/settings` — statuses, custom fields, task types. |
| **Identity** | Dev-only user switcher behind `getCurrentUser()`. Not real auth. |

**Verified:** 149 unit tests, 45 live-Postgres checks, 17 server-action checks,
four packages typechecking clean.

**The renderer bet, measured.** Adding the board took no compiler change, no new
SQL, and one new server action (`moveTask`, because dragging is a mutation the
list never needed). Every renderer now reads through `loadView`, and the list
page's rendered output is byte-for-byte identical before and after being moved
onto it. Calendar and Table should be the same shape of work; if either one
needs its own query, that is the signal the compiler is missing something
rather than the renderer being special.

**Not verified:** nothing in a real browser. The Claude-in-Chrome extension has
failed to connect across three sessions, so no click has been observed. The
settings pages are confirmed to render the seeded data correctly over HTTP, and
every action is confirmed to work when invoked — but *that a click reaches the
handler* is unproven for the settings screen. That is the one gap left, and it
is the same class of gap that hid the undo bug.

---

## What is deliberately not built

- `apps/realtime` and `apps/worker` — empty directories with no `package.json`.
  Neither earns its keep until there are mutations to broadcast and automations
  to run. The README describes them; that is aspirational, not current.
- `packages/sdk` — empty. Needed once there's an API worth a typed client.
- Real auth, permissions UI, guests — Phase 5.
- Every view renderer except List.
- Docs, chat, dashboards, goals, time tracking, automations, AI.
- Derived field types (`formula`, `rollup`, `automatic_progress`) are declared
  and filterable, but nothing computes them yet — that is worker work.

---

## Where to pick up

**Immediate:** drag a card on `/board` and click through `/settings` in a real
browser. The server half of both is verified — every action is exercised by
`check:actions` — but no click or drag has ever been observed. Native HTML5
drag in particular has behaviour no HTTP check can see.

**Next — saved views and the filter bar.**

1. **Saved view CRUD** — the `views` table already drives both renderers, and
   `loadView` reads the definition from it. What is missing is writing one:
   create, rename, duplicate, set default.
2. **The filter bar** — build a `FilterGroup` from real fields, with operators
   narrowed by type. `FIELD_TYPE_META` knows which operators each type allows
   and `parseFilterValue` rejects the rest, so the UI's job is to not offer them.
3. **Table and Calendar** — both are renderers over the same compiled view. The
   board took no compiler change; these should not either.

**Then:** real auth and permissions (Phase 5).

---

## Environment gotchas on this machine

- **Port 3000 is another project.** Use 3100 for Arbor.
- **Docker Compose plugin is not installed** — only the Docker CLI. So
  `npm run docker:up` fails. Fix with `brew install docker-compose`, or keep
  using the `docker run` line above. The compose file itself is correct.
- **Colima must be started manually** (`colima start`) and is slow on disk.
- **pnpm and corepack are absent**, which is why this is an npm-workspaces repo
  (D-004). The root `packageManager` field pins npm — Turborepo 2.10 refuses to
  resolve the workspace without it.
- **The Claude-in-Chrome extension does not connect.** Four sessions, same
  result. `check:actions` exists because of it — it warms the routes it needs
  and then sends the request a click sends.
- **21st.dev MCP** is configured at local scope in `~/.claude.json` (not in the
  repo — the key must never be committed). **Its tools require a Claude Code
  restart to load.** Not yet used; `packages/ui` has the tokens and an empty
  `ATTRIBUTIONS.md` waiting.

---

## Read these first

| File | Why |
|---|---|
| `DECISIONS.md` | 51 entries. Every non-obvious choice, the alternatives rejected, and the trade-off accepted. Written for explaining the project out loud. D-049 is the most interesting one to talk through. |
| `docs/decisions/` | Five ADRs — the structural choices most expensive to reverse. |
| `docs/design-plan.html` | Interface plan: palette, type, density, screens, keyboard map, AWS topology. Open in a browser. |
| `docs/work-os-research.html` | The architecture teardown the whole project is built from. |
| `packages/core/src/views/compile.ts` | The heart of the product. Read this before changing anything about querying. |
| `packages/core/src/fields.ts` | The field type system. Everything about a custom field is declared here once. |

---

## Open questions

- **Enterprise features** — in the open repo, or a separately-licensed `ee/`
  directory? Decide before writing the first line of SSO; choosing afterwards
  means an awkward public relicensing.
- **Hiding an inherited field.** Fields accumulate down the tree and cannot be
  suppressed lower (D-046). If a real case appears, it should be an explicit
  per-container suppression rather than a change to the inheritance rule.
- **Two position columns.** `tasks.position` and `task_lists.position` both
  exist; only the first is read for ordering, and the board writes it. They
  diverge the moment a task can sit at a different place in two lists, which is
  what `task_lists` exists for (D-010). Decide which is authoritative before
  building multi-list ordering, not after.
- **Keyboard and touch on the board.** Native drag has neither (D-051). Moving
  between statuses has a keyboard path already; reordering within a column does
  not.
