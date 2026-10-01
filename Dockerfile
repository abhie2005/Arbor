# Arbor, as two images built from one tree (D-114).
#
#   --target runner    the app. Next's traced standalone output on a bare Node
#                      image: no build tooling, no devDependencies, no npm.
#   --target migrator   a one-off task that runs `drizzle-kit migrate`.
#
# **Why the migrator is a separate, fatter image rather than a script in the
# runner.** Migrations could be applied by a hand-written runner using `pg`
# alone, which would be smaller — and would be a second thing that decides what
# "already applied" means, disagreeing with `drizzle-kit` the first time the
# bookkeeping format changed. One migration runner in the project, used both
# locally and on ECS, is worth a short-lived image that carries devDependencies.
#
# Built for linux/amd64 to match the Fargate platform default; pass
# `--platform linux/amd64` explicitly when building on an Apple Silicon machine.

# --- dependencies -------------------------------------------------------------
# Only the manifests are copied here, so this layer is reused on every build
# that did not change a dependency — which is nearly all of them.
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
RUN npm ci

# --- build --------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY . .

# The build must not reach a database. Next evaluates modules while collecting
# page data, and `@arbor/db` throws from `connectionString()` when DATABASE_URL
# is absent — so a placeholder is supplied and never connected to. Every route
# is `force-dynamic`, so nothing is prerendered against it.
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build -w @arbor/web

# --- the app ------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Bind all interfaces: the ALB reaches the task on its private IP, and Next's
# default of localhost would refuse that connection while looking healthy
# inside the container.
ENV HOSTNAME=0.0.0.0

# Runs as a non-root user that the base image already provides, so there is no
# useradd here to drift from it.
USER node

# `standalone` already contains the traced `node_modules`, the workspace
# packages and a `server.js`. Static assets are not traced — Next leaves them
# to be copied beside the server, which is why these are two COPYs and not one.
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000

# No shell form: with `CMD node …` the process is PID 1 and receives the
# SIGTERM that ECS sends to drain a task. Through a shell it would not, and
# every deploy would end in a 30-second kill instead of a clean stop.
CMD ["node", "apps/web/server.js"]

# --- migrations ---------------------------------------------------------------
# Run as a one-off ECS task before the service is updated. It needs the schema
# source (drizzle.config.ts reads it), the SQL files, and drizzle-kit itself.
FROM node:22-alpine AS migrator
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages/core ./packages/core
COPY packages/db ./packages/db
USER node

# **The working directory is the package, not the repo root**, and that is the
# whole trick. `drizzle.config.ts` says `out: "./migrations"`, which resolves
# against the process's cwd — so running this from `/repo` with `--config
# packages/db/...` finds the config and then looks for the SQL in
# `/repo/migrations`, failing with "Can't find meta/_journal.json". Locally
# `npm run db:migrate -w @arbor/db` sets the cwd to the package, so matching
# that is what makes the container and a developer run the same command.
WORKDIR /repo/packages/db

# `npx --no-install` so a missing drizzle-kit fails here rather than silently
# fetching a different version than the one the lockfile pinned.
CMD ["npx", "--no-install", "drizzle-kit", "migrate"]
