# Status — resume here

Last updated 2026-09-01. Repo: https://github.com/abhie2005/clickup-alt (`main`).

This file exists so a new session, or a future you, can pick the project up
without re-deriving anything. Update it whenever you stop mid-stream.

---

## OPEN BUG — undo does not work in the browser

**Status: unresolved. Two attempted fixes both failed. Do not assume it is
fixed.**

**Symptom.** Click a status dot — the task moves, correctly. The Undo button
lights up showing depth `1`. Click Undo (or press ⌘Z) — a toast appears
claiming the change was undone, but the row does not move back.

### What is already ruled out

- **The write path is not the problem.** `npm run db:smoke` applies an
  operation, applies its inverse, and asserts the original value is restored
  directly against Postgres. It passes. `invert()` and `invertBatch()` have 24
  unit tests. The server-side machinery works.
- **The stack is not empty.** The button shows depth `1`, which reads from the
  module-scope store, so the inverse was recorded.

### What was fixed along the way (real bugs, but not this one)

Both of these were genuine defects worth fixing. Neither resolved the symptom,
so **do not treat them as the explanation**:

1. **D-038** — the stack was in a `useRef` that `revalidatePath` could wipe on
   remount. Moved to module scope.
2. **D-040** — the action was `void`-called outside a transition, so Next.js
   never applied the refreshed payload, and the toast fired before the server
   answered. Now awaited inside `startTransition` with `router.refresh()`.

### Why the diagnosis stalled

Every fix so far was **reasoned from the code, never observed in a browser** —
the Claude-in-Chrome extension would not connect, so nothing was verified end
to end. That is exactly how two plausible-but-wrong fixes shipped in a row.

### How to actually diagnose it — do this first, before changing any code

Open the app with devtools:

1. **Network tab** → click Undo → find the POST to `/`. Check:
   - Does the request fire at all? (If not, the handler is not running.)
   - What is the response status? A 500 means the action threw.
   - Does the response contain a fresh RSC payload, or just the return value?
2. **Console tab** → look for a React or Next error on click.
3. **Check the database directly** while the UI still looks unchanged:
   ```bash
   docker exec arbor-pg psql -U arbor -d arbor -c \
     "SELECT key, status_id FROM tasks WHERE key='ENG-415';"
   ```
   - **Value changed back** → the write works, the UI is not re-rendering.
     The bug is in the refresh path, not the mutation.
   - **Value unchanged** → the action is failing or being filtered. Check
     `activity` for a row, and whether `applyOperations` returned
     `applied: 0` (an `isNoop` mismatch would do that).

That single check splits the remaining hypotheses in half. Report which side it
lands on before writing a fix.

### Untested hypotheses worth holding

- The `Operation` objects may not survive the server-action serialization
  boundary intact — verify `from`/`to` server-side by logging in `undo()`.
- `revalidatePath("/")` combined with `export const dynamic = "force-dynamic"`
  may not invalidate the client Router Cache as expected.

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
| **List view** | Renders through the compiler. Status cycling, priority cycling, inline rename, archive, inline create all work. **Undo does not — see the open bug above.** |
| **Identity** | Dev-only user switcher behind `getCurrentUser()`. Not real auth. |

**Verified:** 80 unit tests, 16 live-Postgres smoke checks, three packages
typechecking clean.

**Confirmed working in a browser** (2026-09-01): status cycling, inline
rename, inline create, archive, the dev user switcher.

**Confirmed broken:** undo. See the open bug at the top of this file.

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

**Immediate:** the undo bug above. It is small in scope but it is a
correctness bug in the mutation layer's most visible feature, and the fix is
gated on one browser observation, not on more code reading.

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
