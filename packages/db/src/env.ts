import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { config } from "dotenv";

/**
 * Finds and loads the monorepo root `.env`.
 *
 * In a workspace, the `.env` lives at the repo root but processes start
 * wherever they start — `apps/web` for the dev server, `packages/db` for the
 * seed script, the root for turbo. Next.js only looks in its own app directory,
 * so `cp .env.example .env` at the root (which is what the README says to do)
 * left the app with no DATABASE_URL and a confusing "could not reach the
 * database" screen.
 *
 * Rather than scatter copies of `.env` through the workspace, walk up from the
 * current directory until we find one.
 *
 * `override: false` matters: an inline `DATABASE_URL=... npm run x`, and real
 * environment variables in production, must always win over the file.
 */

function findEnvFile(startDir: string, maxDepth = 6): string | undefined {
  let current = resolve(startDir);

  for (let depth = 0; depth <= maxDepth; depth++) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) break; // reached the filesystem root
    current = parent;
  }

  return undefined;
}

let loaded = false;

/** Idempotent — safe to call from every entry point. */
export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;

  const envPath = findEnvFile(process.cwd());
  if (envPath) config({ path: envPath, override: false, quiet: true });
}

/** The path we searched from, for error messages that actually help. */
export function envSearchOrigin(): string {
  return process.cwd();
}
