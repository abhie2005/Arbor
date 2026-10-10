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
npm run typecheck
```

`db:generate` then `db:migrate` for schema changes; rename the generated
migration to something descriptive and update `migrations/meta/_journal.json`.

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
   `dueHasTime` decides. Never format one without asking.
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

## Conventions

- **Log every non-obvious call in `DECISIONS.md`** — the choice, the rejected
  alternatives, the trade-off accepted. Next id continues the sequence. Written
  to be explained out loud.
- **Commit and push each verified chunk**, on `main`. Do not batch.
- **Gates before any commit**: `npm test`, `db:smoke`, `check:actions`,
  `check:search`, `typecheck` — plus driving it in Chrome for anything with a UI.
  `check:search` is the one that runs against the **container image** as happily
  as a dev server (D-115), which is what to reach for when `next dev` will not
  start on this machine.
- A new check should **fail if the fix is reverted**. Verify that it does.
- Infrastructure stays on AWS/GCP or self-hosted Docker. No Vercel, no hosted
  database vendors, no auth SaaS.

## Environment gotchas that cost real time

- **The first click after a navigation is swallowed** while the dev server
  hydrates. It looks exactly like a broken handler. Click twice, or wait.
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
- **`docker` cannot pull: `docker-credential-desktop` not found.**
  `~/.docker/config.json` names a credential helper that is not installed. The
  images here are public, so a clean config is enough for one command:
  `DOCKER_CONFIG=$(mktemp -d) docker pull …`.
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
- **`check:actions` cannot run against a production build.** `actionIds()` reads
  the `exportedName` manifest that only a dev build emits; a production build's
  `server-reference-manifest.json` maps action ids to routes but carries no
  export names, because they are minified away. So the gate needs `next dev`,
  and that is inherent rather than an oversight.
- Deleting a `grants` row does **not** update `access_index`. Revoke properly or
  clear both, or the next thing you check sees stale access.
- **A dev-server 503 on `/api/live` or an `?_rsc=` request** is Next compiling,
  not a bug in the stream. It resolves on the next attempt; check twice before
  chasing it.
- **A `"use server"` file may only export async functions.** Exporting a
  constant from one fails the whole module at build time, and it surfaces as a
  server action returning `A "use server" file can only export async functions`
  rather than as a compile error — so typecheck passes and only
  `check:actions` catches it. Types are fine (they are erased); shared runtime
  values go in a plain module, e.g. `components/card-options.ts`.
- **Postgres's clock is not this machine's.** It runs in the Colima VM and
  drifts tens of milliseconds either way. A check that fences on `activity.at`
  with `new Date()` lets the previous section's writes through at random — take
  the fence from `SELECT now()`.
- **`activity.field` is the SQL column name** (`status_id`), not the operation's
  (`statusId`) — and for a comment it is the *comment id*, and for a custom
  field the field id. Read the verb first; anything that reads `field` without
  asking ends up printing a uuid at somebody.
