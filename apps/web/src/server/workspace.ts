import "server-only";

import { pool } from "@arbor/db";

/**
 * The workspace this deployment shows.
 *
 * Today that is the seeded demo, looked up by slug. It is a function rather
 * than a constant so the swap to "the workspace this request belongs to" —
 * which arrives with real auth in Phase 5 — happens in one place instead of in
 * every page that needs an id.
 */

const DEMO_SLUG = "northwind";

export interface WorkspaceContext {
  id: string;
  name: string;
}

export async function currentWorkspace(): Promise<WorkspaceContext | null> {
  const result = await pool().query<WorkspaceContext>(
    `SELECT id, name FROM workspaces WHERE slug = $1 LIMIT 1`,
    [DEMO_SLUG],
  );
  return result.rows[0] ?? null;
}

export async function requireWorkspace(): Promise<WorkspaceContext> {
  const workspace = await currentWorkspace();
  if (!workspace) {
    throw new Error("No workspace found. Run `npm run db:seed` to create the demo workspace.");
  }
  return workspace;
}
