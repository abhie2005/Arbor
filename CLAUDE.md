# Arbor — working notes for Claude

A dense, keyboard-driven work platform. Hierarchies, saved views, custom fields,
collaboration. AGPL-3.0, self-hostable, npm workspaces + Turborepo.

**It is not a ClickUp clone** (D-001). The architecture was researched, the
product built from the patterns. Do not describe it as a clone.

## Read this first, not the whole repo

This file is the map. **Do not explore the tree to orient yourself** — go
straight to the file you need below. `docs/STATUS.md` is current state and what
is next; read it when resuming work, not to learn how things fit together.

## Commands

```bash
colima start && docker start arbor-pg     # Postgres. Colima is manual on this Mac.
cd apps/web && npx next dev -p 3100       # NOT 3000 — another project owns it

npm test                                  # unit, no database
npm run db:seed && npm run db:smoke       # against real Postgres
PORT=3100 npm run check:actions           # POSTs what a click posts; needs the dev server
npm run check:api -- 3100                 # the public API over HTTP; any server will do
npm run check:browser -- 3100             # drives Chrome as four people; any server will do
npm run typecheck
```

**`db:generate` does not run on this machine.** It dies with `TypeError: Do not
know how to serialize a BigInt` inside `diffSchemasOrTables` before writing
anything — with the schema unchanged as readily as with a new table, so it is
the tool and not the schema (D-133). A migration is therefore **hand-written**:
add the `.sql`, add its entry to `migrations/meta/_journal.json`, and
`db:migrate` applies it. The cost is that `meta/*_snapshot.json` stops
describing the schema, so a `generate` that starts working will re-propose what
it never recorded — already true of 0011 for a different reason.

When it does run: `db:generate` then `db:migrate`, renaming the generated
migration to something descriptive and updating the journal.
**Check what `generate` proposes before applying it**: 0011's trigram indexes
were hand-written with `IF NOT EXISTS`, so the drizzle snapshot never recorded
them and every generate re-proposes them without the guard — which fails on any
database that has actually run 0011 (D-120).

There are two databases on the local Postgres. `arbor` is the real one, named
by `.env`, and what `db:seed`, `db:smoke` and a host dev server use.
`arbor_check` is a scratch copy for driving the app in a browser without
touching the first; it is migrated and seeded, and nothing depends on it
surviving — drop and recreate it freely.

```bash
# The container image. Two targets; --platform matters on Apple Silicon because
# the Fargate task definition declares X86_64 (D-114).
docker build --platform linux/amd64 --target runner   -t arbor-web .
docker build --platform linux/amd64 --target migrator -t arbor-migrator .

cd infra/terraform && terraform validate   # no credentials needed
```

Deploying is `infra/terraform/README.md`, not guesswork — the first deploy is
two applies, because the registry must exist before an image can be pushed.

## Invariants — breaking these silently is the main risk

1. **`applyOperations` is the only thing that writes task data.** Every mutation
   is an `Operation` (`packages/core/src/mutations.ts`), so the activity log and
   undo come free. A service with its own INSERT is the second writer, and the
   second writer is the one that forgets to log (D-083). Configuration is the
   documented exception — statuses, fields, types, grants, goals, dashboards and
   a document's place in the tree write through `logConfigChange` instead, which
   gets the activity row without the undo entry (D-103, D-111).
2. **No renderer has a query of its own.** Every view reads through
   `compileViewQuery`. A renderer needing something the compiler cannot say
   means the compiler grows (D-078), not that the renderer writes SQL (D-032).
   A goal's rollup obeys this too: `key_results.source` holds a view definition
   and `compileAggregate` shares `buildBase` with the row query, so a goal and a
   list cannot disagree about what counts (D-101). A dashboard card is the same
   bet again, and its `kind` *is* which entry point it calls (D-104).
3. **Whose permissions a number is computed with is a decision, not a default.**
   A goal's rollup runs as the goal's **owner**, so a shared commitment reads
   the same for everyone (D-102). A dashboard card runs as the **viewer**,
   because a dashboard lives in a container and the tree's rule is that you see
   what you have a grant on (D-105). Two readers disagreeing about a dashboard
   is correct; two readers disagreeing about a goal would not be.
4. **Every server action authorizes, not just authenticates.** `requireUser`
   says who; `requireTaskAccess` / `requireListAccess` / `requireContainerAccess`
   / `requireViewAccess` / `requireWorkspaceRole` say whether (D-080, D-081).
   **Which one is a decision**: sharing one container takes `manage` on it
   (D-109), while status sets, custom fields and task types are scoped to no
   container and take the workspace role.
   **`submitFormAction` is the one exception, and it is deliberate** (D-142,
   D-143): a public form is filled in by somebody with no account, so there is
   no principal to authorize. What stands in for it is narrower and is not held
   by the caller — a manager wrote the form, the form names the list and the
   fields, the write happens as the form's own `guest` principal, and
   `parseSubmission` refuses anything the form did not ask for. **Do not "fix"
   it by adding `requireUser`**; that deletes the feature.
5. **Reads are permission-scoped by joining `access_index`.** Grants are truth;
   the index is what queries join (ADR 3). It holds a row per (person,
   **container**) — every kind, not only lists (D-108) — so "may this person
   manage this space" is the same join as "may they see this task". The detail
   page does this by hand because it does not go through the compiler.
6. **Refusals never leak existence.** Unreachable reads as "no longer exists",
   in the same words as genuinely missing. Insufficient permission says so.
7. **One document format** for comments, descriptions and docs — a block tree
   with mention *nodes* carrying user ids, `packages/core/src/richtext.ts`.
   Never store a mention as the characters "@Name" (D-083). A doc is that same
   tree in Yjs types, and what every non-editor reads is the projection back to
   it (ADR 6, D-110) — never the CRDT. **Inside the editor a mention is one
   `EMBED_CHAR`** (D-117): Yjs counts an embed as one position, so spending one
   UTF-16 code unit on it makes a DOM offset, a caret and a `Y.Text` offset the
   same number. Read a paragraph with `blockString`, never `Y.Text.toString()`
   — that one drops embeds, and every offset after a mention comes out one
   short while the text looks right.
8. **Notifications: direct signals only.** Assigned, mentioned, replied write a
   row inside the causing transaction. Everything ambient is aggregated at read
   time from `activity` (`loadAmbient`) — fanning out to watchers is the
   200-rows-per-edit mistake the table is shaped to avoid, and so is giving a
   watcher a read flag per event: the ambient half's read state is one mark per
   membership (D-088).
9. **Dates**: a date-only value is midnight UTC and read in UTC (D-067).
   `dueHasTime` decides. Never format one without asking. **A writer of a
   calendar day owes the flag as well as the value** — it is a property of the
   value rather than an operation of its own, so it is written beside
   `applyOperations` rather than through it. There are two such writers now: the
   calendar's `setTaskDate`, and `markDatesAsDays` for anything an automation
   resolves (D-147). An automation therefore cannot write a *timed* date, which
   is a cost rather than an oversight.
10. **An operation must survive JSON.** It is handed to the client as an
   inverse and posted back by `undo`, so a `Date` on one arrives as a string and
   every helper that calls a date method on it throws. Instants on operations
   are ISO strings (D-097). Typechecks, unit tests and `db:smoke` all pass while
   this is wrong; `check:actions` is what catches it.
11. **A control that shows a server value must follow it.** `useState(props.x)`
   takes the value once and never looks again, which no test in this repo can
   see — every check passed while a live rename left the old name on screen.
   Use `useServerValue` (D-090).
12. **Announcing is `applyOperations`' job, once per batch.** Not
    `logActivity`'s any more (D-099): the nudge carries who the fan-out told,
    and the fan-out has not run when the activity row is written. A new
    operation still cannot forget to broadcast, because there is no way to apply
    one except through `applyOperations`. Configuration services announce for
    themselves — `documents.ts` does, because a page appearing in somebody
    else's tree is news (D-112).
13. **A nudge is answered by re-rendering, except for a document.** The server
    knows every other new value; a document's lives in the editor's CRDT, and a
    `router.refresh()` there throws away the cursor and anything unsaved. A doc
    nudge carries `d` and the editor pulls the difference (D-112).
14. **The app reads three environment variables**, and that is what makes it
    deployable anywhere: `DATABASE_URL`, `NODE_ENV`, `PORT`. Everything else in
    `.env` — `STORAGE_*`, `SMTP_*`, `QUEUE_*`, `LLM_*`, `REDIS_URL` — is read by
    nothing and describes an intention, not a wiring (D-114). Adding a fourth is
    a real decision: it is a new thing every environment has to supply, and the
    Fargate task definition, the Compose file and `.env.example` all have to
    learn it together.
15. **One rule for what "matches".** Search is case-insensitive substring via
    `ILIKE`, in both halves — the compiler's `filters.search` for tasks and
    `searchDocs` for pages — and they share `escapeLike` so `100%` cannot mean a
    wildcard in one and a per-cent sign in the other (D-113). A `tsvector` on one
    half only is the bug this forbids: it looks like a missing document, not like
    two matchers. Moving to full-text search means moving both, in one change.

## Where things are

| Need | File |
|---|---|
| The view compiler — read before touching querying | `packages/core/src/views/compile.ts` |
| Field type system (20 types declared once) | `packages/core/src/fields.ts` |
| Operations, invert, undo stack | `packages/core/src/mutations.ts` |
| Permission rule (pure) | `packages/core/src/access.ts` |
| Rich text / mentions | `packages/core/src/richtext.ts` |
| A document as Yjs, and its projection back | `packages/core/src/documents.ts` |
| Documents: the page tree and the bytes | `packages/db/src/documents.ts` |
| The editor: a contenteditable per paragraph, the diff, the caret | `apps/web/src/components/doc-editor.tsx` |
| What ⌘Z may take back in a document (pure) | `documentUndoManager` in `packages/core/src/documents.ts` |
| Who gets notified (pure) | `packages/core/src/notifications.ts` |
| The executor — all writes land here | `packages/db/src/mutations.ts` |
| Authorization checks | `packages/db/src/task-access.ts` |
| Comment reads (writes are operations) | `packages/db/src/comments.ts` |
| Fan-out + inbox queries | `packages/db/src/notifications.ts` |
| The inbox screen and its badge | `apps/web/src/server/inbox.ts`, `app/inbox/page.tsx` |
| What a group of changes reads as (pure) | `packages/core/src/activity.ts` |
| Reading the activity log | `packages/db/src/history.ts` |
| Live changes: publish and subscribe | `packages/db/src/live.ts` |
| Duration rules and formatting (pure) | `packages/core/src/time.ts` |
| Tracked time as a totalled field | `trackedMs` in `packages/core/src/views/compile.ts` |
| Key-result kinds, progress arithmetic (pure) | `packages/core/src/goals.ts` |
| Goals, key results, and running a rollup | `packages/db/src/goals.ts` |
| Dashboard cards: what each kind compiles to | `packages/core/src/dashboards.ts` |
| Running a dashboard's cards | `packages/db/src/dashboards.ts` |
| Reading tracked time (writes are operations) | `packages/db/src/time.ts` |
| The timer panel and the one in the shell | `apps/web/src/components/task-time.tsx`, `running-timer.tsx` |
| The stream, and who may hear a nudge | `apps/web/src/app/api/live/route.ts` |
| Who else is looking at a task | `apps/web/src/server/presence.ts` |
| An editable value that follows the server | `apps/web/src/components/use-server-value.ts` |
| Schema | `packages/db/src/schema/` |
| Seed — the demo workspace | `packages/db/src/seed.ts` |
| Loading a view for any renderer | `apps/web/src/server/views.ts` |
| Search: the term, the snippet, the marks (pure) | `packages/core/src/search.ts` |
| Search: the two halves and their permissions | `apps/web/src/server/search.ts` |
| Task detail loader | `apps/web/src/server/task.ts` |
| Server actions (the API boundary) | `apps/web/src/server/*-actions.ts`, `actions.ts` |
| Shared page chrome | `apps/web/src/components/app-shell.tsx` |
| The one hook every writing control uses | `apps/web/src/components/use-task-action.ts` |
| All styles | `apps/web/src/app/app.css` (tokens in `packages/ui/src/tokens.css`) |
| The container image — two targets, app and migrator | `Dockerfile` |
| AWS: VPC, RDS, Fargate, ALB, ECR (D-114) | `infra/terraform/` |
| How to deploy it, and what is not done | `infra/terraform/README.md` |
| The load balancer's health check | `apps/web/src/app/api/health/route.ts` |
| API tokens: what one is and who it speaks as (D-133) | `packages/db/src/api-tokens.ts` |
| What a form asks, and what an anonymous submission may say (pure) | `packages/core/src/forms.ts` |
| Forms: the service account, the submission, the ceiling | `packages/db/src/forms.ts` |
| The public form page — the only screen that renders with no session | `apps/web/src/app/f/[id]/page.tsx` |
| The public API's read half | `apps/web/src/app/api/v1/views/query/route.ts` |
| The public API's write half | `apps/web/src/app/api/v1/operations/route.ts` |
| An operation off the wire, validated (D-134) | `parseOperations` in `packages/core/src/mutations.ts` |
| Bearer auth for the API, and its one refusal shape | `apps/web/src/server/api-auth.ts` |
| The Chrome gate: four identities, two zones, one absence (D-144) | `apps/web/scripts/check-browser.mts` |
| Retry policy, and the attempt limit's reasoning (pure, D-145) | `retryAfterSeconds` in `packages/core/src/automations.ts` |
| Filter menus, and the only permission-scoped set in them (D-146) | `loadFilterOptions` in `apps/web/src/server/views.ts` |
| Settling a run a dead process abandoned (D-145) | `reapStrandedRuns` in `packages/db/src/automations.ts` |
| What a date an action sets resolves to, at the moment it acts (D-147) | `resolveValue` in `packages/core/src/automations.ts` |

## Conventions

- **Log every non-obvious call in `DECISIONS.md`** — the choice, the rejected
  alternatives, the trade-off accepted. Next id continues the sequence. Written
  to be explained out loud.
- **Commit and push each verified chunk**, on `main`. Do not batch.
- **Gates before any commit**: `npm test`, `db:smoke`, `check:actions`,
  `check:search`, `check:api`, `check:browser`, `typecheck`.
  **`check:browser` is the Chrome pass, and it is a command now rather than
  something to remember** (D-144). Thirty checks driving four identities. Three
  things are visible to it and to nothing else: a hydration mismatch, which is a
  console message and no part of any response; which workspace a *screen*
  infers, where every other gate is told; and a row a screen shows that should
  not be there at all. It does not replace *looking* at a new screen — it
  replaces re-driving the old ones.
  `check:search`, `check:api` and `check:browser` all run against the
  **container image** as happily as a dev server (D-115), which is what to reach
  for when `next dev` will not start on this machine. `check:actions` is the one
  that cannot — see below.
- A new check should **fail if the fix is reverted**. Verify that it does.
- Infrastructure stays on AWS/GCP or self-hosted Docker. No Vercel, no hosted
  database vendors, no auth SaaS.

## Environment gotchas that cost real time

- **A browser pass is `npm run check:browser`** (D-144). It no longer needs
  Claude's Chrome extension, a scratch directory or a Playwright install: the
  dependency is `playwright-core` and the browser is **the Google Chrome already
  on this machine**, via `channel: "chrome"`. `ARBOR_CHROME=/path/to/binary`
  overrides it. Do not install `playwright` into this repo to "fix" a browser
  problem — that reintroduces the 130MB download the core package exists to
  avoid.
  **The server must not be in the browser's zone or half of it proves nothing.**
  The container image is alpine and therefore UTC, which is what you want; a
  host dev server needs `TZ=UTC` in front of it. The browser is pinned to
  `America/Los_Angeles` inside the script.
  It writes one fixture — ENG-421's due date, to an instant whose UTC and
  Pacific days always differ — because the seed's own timed row inherits the
  hour `db:seed` ran at.
  **`warmUp()` is load-bearing, not politeness**: a chunk requested while a
  route is still compiling 404s, and from inside a browser that reads as a
  missing asset rather than as a server still building. So every route is
  requested once and whatever it said is discarded, and the console assertions
  come after. Do not move them above it. Against a cold container the run takes
  a couple of minutes, nearly all of it that first pass.
- **The first click after a navigation is swallowed** while the dev server
  hydrates. It looks exactly like a broken handler. Click twice, or wait.
- **A read of this repo can fail with `ETIMEDOUT`, and it is not the network.**
  `~/Desktop` is iCloud-synced, so a file that has been evicted is fetched on
  read — and under load that fetch times out. It surfaces as nonsense:
  `readFileSync` of `node_modules/tsx/dist/preflight.cjs` failing with
  `errno: -60, syscall: 'read'`, `git checkout` reporting
  `read error while indexing packages/db/src/client.ts`, or an
  `ERR_INVALID_PACKAGE_CONFIG` for a `package.json` that is perfectly valid.
  Nothing is corrupt and there is nothing to repair — the same reads succeed
  minutes later. **Check `uptime` before believing any of it**: this was found
  at load average 26 with another application holding a core at 95%, and
  everything above cleared on its own once the machine was idle. A gate that
  appears to hang is this, far more often than it is the gate.
  **The workaround is to stop reading the repo from the host.** The dev image
  holds a *copy* of the source and `node_modules` on Docker Desktop's own
  filesystem, so a throwaway container runs a gate at full speed while iCloud
  sorts itself out — and because it is not the dev server, no automation drain
  writes underneath it:

  ```bash
  DOCKER_HOST="" docker run --rm -w /repo/packages/db \
    -e DATABASE_URL="postgres://arbor:arbor@host.docker.internal:5432/arbor" \
    arbor-dev:local node /repo/node_modules/.bin/tsx src/smoke.ts
  ```

  A host `db:smoke` that had printed nothing for ten minutes, with **no
  connection in `pg_stat_activity` at all** — so it was still loading modules,
  not waiting on a lock — finished all 355 checks this way. Rebuild the image
  first if the source has changed since.
- **Synthetic drags do not trigger HTML5 drag-and-drop.** `left_click_drag`
  fails on the board *and* the calendar — that is the tool, not the app. Verify
  drag by dispatching real `DragEvent`s and checking Postgres.
- **Ports 3000 and 3100 are both other projects on this machine**, and one of
  them moves. `check:actions` fails with `GET /settings/statuses returned 404`,
  which reads as a missing route and is really somebody else's server
  answering. Check who owns the port before believing the 404:
  `lsof -ti:3100 | xargs ps -o args=` — Arbor is Next 15.5.x, so a different
  version in that output is the answer. Run on a free port and pass it:
  `npx next dev -p 3101` with `PORT=3101 npm run check:actions`.
- `npm run docker:up` fails — the Compose plugin is not installed. Use the
  `docker start arbor-pg` line above.
- **There are two Docker daemons on this machine, and `arbor-pg` lives on
  Colima.** `docker context ls` shows `desktop-linux` as current, so a bare
  `docker ps` talks to Docker Desktop and reports **no `arbor-pg`** — which
  looks exactly like the container having been deleted. It has not been. Always
  check the Colima daemon before concluding anything about it:

  ```bash
  docker context use colima          # or, per command:
  DOCKER_HOST="unix://$HOME/.colima/default/docker.sock" docker ps
  ```

  Creating a "replacement" from the Docker Desktop context gives you a *second*
  Postgres, and then two things publish port 5432 — at which point the host and
  a container disagree about which database they are talking to. Symptom: the
  app 500s or redirects to `/login` with a session that the database plainly
  contains, or `docs` is empty in one connection and populated in another.
  `lsof -nP -iTCP:5432 -sTCP:LISTEN` shows both (`ssh` is Colima's forward,
  `com.docker` is Desktop's).
- **`docker` cannot pull or push: `docker-credential-desktop` not found.**
  `~/.docker/config.json` sets `credsStore: desktop`, and the helper is not on
  PATH — but it **is installed**, at
  `/Applications/Docker.app/Contents/Resources/bin/` alongside
  `docker-credential-ecr-login` and `docker-credential-osxkeychain`. Put that
  directory on PATH and the keychain works normally, which is what an
  `aws ecr get-login-password | docker login` needs (D-118):

  ```bash
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
  ```

  For a one-off pull of a public image, a clean config also works and needs no
  helper: `DOCKER_CONFIG=$(mktemp -d) docker pull …`.
- **Build container images on Docker Desktop, not on Colima.** Colima's VM has
  ~1.9GiB and 2 CPUs; Docker Desktop has 7.7GiB and 12. A
  `--platform linux/amd64` production build of this app is an emulated Next
  build and wants the larger one. They are separate daemons, so this costs
  nothing but a context: `docker context use desktop-linux`, or
  `DOCKER_HOST="" docker …`. `arbor-pg` stays on Colima and is untouched — which
  is the point, since the alternative is `colima start --memory 4` and that
  restarts the database.
- **The first host→Postgres connection after Colima starts can take ~30s** while
  the port forward is established. It looks like a hung migration. The second
  connection is instant; do not go hunting for a deadlock before retrying.
- **When the host dev server will not compile, run one in a container.** Built
  from the Dockerfile's `builder` target — which already holds the full source
  and `node_modules` — it was **ready in 1.8s** on a day the host reported
  "Ready in 632s" and then sat on `Compiling /login` forever. The difference is
  the host's `.next` cache state, not the machine's memory, so this is the
  workaround that does not require deleting it:

  ```bash
  docker build --target builder -t arbor-dev:local .
  PGIP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' arbor-pg)
  docker run -d --name arbor-devsrv -p 3300:3000 -e NODE_ENV=development \
    -e HOSTNAME=0.0.0.0 \
    -e DATABASE_URL="postgres://arbor:arbor@$PGIP:5432/arbor_check" \
    -w /repo/apps/web arbor-dev:local \
    node /repo/node_modules/.bin/next dev -p 3000 -H 0.0.0.0
  # the script, tsx and the source are all in the image, so run the gate inside:
  docker exec arbor-devsrv sh -c 'cd /repo/apps/web && node /repo/node_modules/.bin/tsx scripts/check-actions.mts 3000'
  ```

  Use the Postgres container's own IP, **not `host.docker.internal`** — that
  crosses to the other daemon.

  **Or run the dev container on Docker Desktop and reach Postgres through the
  host**, which is what D-129 used and is the better trade on a loaded machine:
  Colima has 2GiB and Desktop has 8, and Colima's port forward means the host's
  5432 *is* `arbor-pg`. Then `host.docker.internal` is right rather than wrong —
  it crosses to the host, which is where the forward is, and the memory note
  below stops applying because the VM is no longer the small one:

  ```bash
  DOCKER_HOST="" docker build --target builder -t arbor-dev:local .
  DOCKER_HOST="" docker run -d --name arbor-devsrv -p 3300:3000 \
    -e NODE_ENV=development -e HOSTNAME=0.0.0.0 \
    -e DATABASE_URL="postgres://arbor:arbor@host.docker.internal:5432/arbor" \
    -w /repo/apps/web arbor-dev:local \
    node /repo/node_modules/.bin/next dev -p 3000 -H 0.0.0.0
  # ready in ~2.6s; both gates run inside it
  DOCKER_HOST="" docker exec arbor-devsrv sh -c \
    'cd /repo/apps/web && node /repo/node_modules/.bin/tsx scripts/check-actions.mts 3000'
  ```

  The image holds a *copy* of the source, so a host edit is invisible until it
  is rebuilt — rebuild and recreate the container before the browser pass that
  is meant to verify the final code. The rebuild is ~6s with warm layers.

  **The host failure mode has a second shape**: `next dev` printing *nothing at
  all* — no banner, no "Ready", 0% CPU, an empty log — rather than compiling
  slowly. Starting it unsandboxed does not help when it looks like this, and
  neither does waiting; it is the container or nothing.

  **Do not raise `--max-old-space-size` to get further.** The Colima VM has
  2GiB, where node's default heap cap is ~1004MB. At the default, Next dev
  notices the ceiling itself, prints "Server is approaching the used memory
  threshold, restarting", and is back in ~1.5s — dropping one in-flight request,
  which surfaced as `fetch failed: ECONNRESET` about 65 checks into
  `check:actions`. Setting 1536 removes that guard rail and lets node grow past
  what the VM can back, so the **kernel** kills the container instead
  (`OOMKilled=true`) while compiling `/t/[key]`'s 1270 modules — 45 checks in.
  Graceful beats dead. The real fix is a bigger VM (`colima stop && colima start
  --memory 4`), which restarts the Postgres container and is therefore the
  user's call, not a thing to do mid-task.
- **A section `check:actions` never reaches can be run on its own.** The script
  is linear top-level code, so its preamble (sign-in, `report`, `callOn`, the
  `pg` client) plus one section's own lines is a runnable file — drop the
  `/settings/statuses` and `/` warms and the `IDS` lookup, which are the
  heaviest compiles and which only `call()` needs. That is how the documents
  section was verified for D-117 on a machine where the full run dies a third
  of the way through. Write it to the scratchpad, `docker cp` it into
  `/repo/apps/web/scripts/`, and delete it afterwards — it is a way of reading
  the gate, not a second gate to maintain.
- **`check:actions` cannot run against a production build.** `actionIds()` reads
  the `exportedName` manifest that only a dev build emits; a production build's
  `server-reference-manifest.json` maps action ids to routes but carries no
  export names, because they are minified away. So the gate needs `next dev`,
  and that is inherent rather than an oversight.
- Deleting a `grants` row does **not** update `access_index`. Revoke properly or
  clear both, or the next thing you check sees stale access. Walked into again
  in D-142, where a deleted form's principal could still write.
- **`db:smoke` and `check:actions` share a database, so do not run them at
  once.** Overlapping runs fail checks that are about neither of them — status
  migration, a batch being one nudge, a rollup agreeing with a list — because
  the other process is writing tasks underneath. The failures look like real
  regressions and move around between runs. One at a time.
  **And `check:search` needs a `db:seed` after `db:smoke`**, which is a
  different problem from the one above: not concurrency but what the smoke run
  *leaves behind*. It rewrites grants and containers as fixtures, and
  `check:search` asserts on the seeded workspace — so four of its eleven checks
  fail on the docs half, reporting "the page containing the phrase was not
  rendered" and accusing permission scoping. `npm run db:seed && npm run
  check:search` is green on the same code. Suspect the order before the change.
- **The drain writes while you are checking it.** A dev server runs the
  automation loop (D-125), so a check about `automation_runs` may find the work
  already done by another process. `db:smoke` asserts outcomes rather than
  counts for this reason (D-145); if a run of it has to be exact, stop the dev
  container first.
- **A dev-server 503 on `/api/live` or an `?_rsc=` request** is Next compiling,
  not a bug in the stream. It resolves on the next attempt; check twice before
  chasing it.
- **A `"use server"` file may only export async functions.** Exporting a
  constant from one fails the whole module at build time, and it surfaces as a
  server action returning `A "use server" file can only export async functions`
  rather than as a compile error — so typecheck passes and only
  `check:actions` catches it. Types are fine (they are erased); shared runtime
  values go in a plain module, e.g. `components/card-options.ts`.
- **`TZ` does nothing in the container, and the failure looks like a pass.** The
  image is alpine, alpine ships no `tzdata`, and node falls back to **UTC**
  without a word when `TZ` names a zone it cannot load. So a two-zone render
  comparison "agrees" because both sides were UTC (D-132). Add it to the
  container's own command, not the image:

  ```bash
  DOCKER_HOST="" docker run -d --name arbor-devsrv -p 3300:3000 \
    -e NODE_ENV=development -e HOSTNAME=0.0.0.0 -e TZ=America/Los_Angeles \
    -e DATABASE_URL="postgres://arbor:arbor@host.docker.internal:5432/arbor" \
    -w /repo/apps/web arbor-dev:local \
    sh -c 'apk add --no-cache tzdata >/dev/null 2>&1; exec node /repo/node_modules/.bin/next dev -p 3000 -H 0.0.0.0'
  ```

  Check it took before trusting the result: `docker exec arbor-devsrv date`
  prints `PDT`, and `node -e 'console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)'`
  prints the zone rather than `UTC`.
- **The dev container dies of its own heap if it is left running**, and
  `--max-old-space-size` only buys time. `next dev` reached
  `FATAL ERROR: Reached heap limit` after a few idle hours at the default, and
  again ~14 hours later with the heap at 3072 — the container exits **0** both
  times, so it reads as something having stopped it cleanly rather than as a
  crash. Treat it as per-session: recreate the container when you come back
  rather than expecting yesterday's to still be serving. `-e
  NODE_OPTIONS=--max-old-space-size=3072` is still worth passing on **Docker
  Desktop**; the note above about *not* raising it applies to Colima, whose VM
  cannot back a bigger heap.
- **Postgres's clock is not this machine's.** It runs in the Colima VM and
  drifts tens of milliseconds either way. A check that fences on `activity.at`
  with `new Date()` lets the previous section's writes through at random — take
  the fence from `SELECT now()`.
- **`activity.field` is the SQL column name** (`status_id`), not the operation's
  (`statusId`) — and for a comment it is the *comment id*, and for a custom
  field the field id. Read the verb first; anything that reads `field` without
  asking ends up printing a uuid at somebody.
