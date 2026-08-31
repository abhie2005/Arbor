# Status — resume here

Last updated 2026-08-31. Repo: https://github.com/abhie2005/clickup-alt (`main`).

This file exists so a new session, or a future you, can pick the project up
without re-deriving anything. Update it whenever you stop mid-stream.

---

## Get running in 3 commands

```bash
colima start                                   # Docker daemon (Colima on this Mac)
docker start arbor-pg || docker run -d --name arbor-pg \
  -e POSTGRES_USER=arbor -e POSTGRES_PASSWORD=arbor -e POSTGRES_DB=arbor \
  -p 5432:5432 postgres:17-alpine
cd apps/web && npx next dev -p 3000
```

Then `http://localhost:3000`. **First compile takes ~5 minutes on this machine**
(Colima disk I/O) — it is not hung.

Verify without the browser:

```bash
npm test                                       # 80 unit tests, no database needed
npm run db:seed && npm run db:smoke            # 16 checks against real Postgres
```

---

## What works today

| Area | State |
|---|---|
| **Schema** | 43 tables, 9 enums, 116 indexes. Migrated and seeded. |
| **View compiler** | Definition → one parameterized SQL query. Filters, grouping, sorting (built-in *and* custom fields), group counts, permission scoping. |
| **Hierarchy** | Config inheritance, effective privacy, denormalized ancestors, move-legality. |
| **Ordering** | Fractional indices — one row written per drag. |
| **Mutations** | Invertible operations, one transaction per batch, activity row per change, real undo. |
| **List view** | Renders through the compiler. Status cycling, priority cycling, inline rename, archive, inline create, ⌘Z. |
| **Identity** | Dev-only user switcher behind `getCurrentUser()`. Not real auth. |

**Verified:** 80 unit tests, 16 live-Postgres smoke checks, three packages
typechecking clean.

**Not verified:** nobody has clicked a button. The Chrome extension was not
connected, so the click → server action → database path is proven only at the
layer boundary, not end to end through the UI. **Do this first when you resume.**

---

## What is deliberately not built

- `apps/realtime` and `apps/worker` — empty directories with no `package.json`.
  Neither earns its keep until there are mutations to broadcast and automations
  to run. The README describes them; that is aspirational, not current.
- `packages/sdk` — empty. Needed once there's an API worth a typed client.
- Real auth, permissions UI, guests — Phase 5.
- Every view renderer except List.
- Docs, chat, dashboards, goals, time tracking, automations, AI.

---

## Where to pick up

**Immediate (30 min):** load the app in a browser and click through the
interactive list. Status dot, priority flag, inline rename, archive, create,
⌘Z. This is the one gap in the verification story.

**Next phase — configuration engines.** The schema is already in place for all
of it; this is service + UI work.

1. **Status sets** — CRUD, inheritance resolution wired to
   `resolveInherited()` in `@arbor/core`, status templates (Scrum/Kanban), and
   the migration prompt when a status is deleted while tasks still use it.
2. **Custom fields** — CRUD per container, the per-type config editor, and
   **validation of field type against filter value at the API boundary** (see
   the sharp edge noted in D-013 — a number filter against a text field
   currently matches nothing, silently).
3. **Task types** — field scoping, so a Bug shows Severity and a Task never does.

**Then:** saved-view CRUD and the filter bar, which completes the view engine
and unlocks Board/Table/Calendar as renderers rather than features.

---

## Environment gotchas on this machine

- **Docker Compose plugin is not installed** — only the Docker CLI. So
  `npm run docker:up` fails. Fix with `brew install docker-compose`, or keep
  using the `docker run` line above. The compose file itself is correct.
- **Colima must be started manually** (`colima start`) and is slow on disk.
- **pnpm and corepack are absent**, which is why this is an npm-workspaces repo
  (D-004).
- **21st.dev MCP** is configured at local scope in `~/.claude.json` (not in the
  repo — the key must never be committed). **Its tools require a Claude Code
  restart to load.** Not yet used; `packages/ui` has the tokens and an empty
  `ATTRIBUTIONS.md` waiting.

---

## Read these first

| File | Why |
|---|---|
| `DECISIONS.md` | 36 entries. Every non-obvious choice, the alternatives rejected, and the trade-off accepted. Written for explaining the project out loud. |
| `docs/decisions/` | Five ADRs — the structural choices most expensive to reverse. |
| `docs/design-plan.html` | Interface plan: palette, type, density, screens, keyboard map, AWS topology. Open in a browser. |
| `docs/work-os-research.html` | The architecture teardown the whole project is built from. |
| `packages/core/src/views/compile.ts` | The heart of the product. Read this before changing anything about querying. |

---

## Open questions

- **Repo name.** `clickup-alt` references ClickUp directly, which cuts against
  the goal of the product standing on its own (D-001). Renaming is a two-minute
  GitHub operation and nothing in the code depends on it.
- **Enterprise features** — in the open repo, or a separately-licensed `ee/`
  directory? Decide before writing the first line of SSO; choosing afterwards
  means an awkward public relicensing.
