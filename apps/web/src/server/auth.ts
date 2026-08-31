import "server-only";

import { pool } from "@arbor/db";
import { cookies } from "next/headers";

/**
 * Identity.
 *
 * Right now this is a development switcher over the seeded users (D-034). Real
 * email/password sessions land in Phase 5 alongside permissions.
 *
 * The rule that makes that swap cheap: **application code only ever calls
 * `getCurrentUser()`**. Nothing else reads the cookie or knows how identity is
 * established. If a component starts reaching for `DEV_USER_COOKIE` directly,
 * this abstraction has leaked and needs fixing before it spreads.
 */

export const DEV_USER_COOKIE = "arbor_dev_user";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
}

/**
 * A development-only bypass that reaches production is a critical
 * vulnerability, and "we'll remember to remove it" is not a control. This is
 * the control.
 */
export function devAuthEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (!devAuthEnabled()) {
    // Phase 5 replaces this branch with a real session lookup.
    throw new Error(
      "Real authentication is not implemented yet. The development user switcher is disabled outside development.",
    );
  }

  const store = await cookies();
  const selected = store.get(DEV_USER_COOKIE)?.value;

  // The cookie is attacker-controlled even in development. Validate its shape
  // before it reaches a query, and let the parameterized lookup do the rest.
  const requested = selected && UUID_RE.test(selected) ? selected : null;

  const result = await pool().query<CurrentUser>(
    requested
      ? `SELECT id, name, email FROM users WHERE id = $1 AND deactivated_at IS NULL`
      : `SELECT id, name, email FROM users WHERE deactivated_at IS NULL ORDER BY created_at LIMIT 1`,
    requested ? [requested] : [],
  );

  return result.rows[0] ?? null;
}

/** Every user in the workspace, for the switcher's dropdown. */
export async function listSwitchableUsers(): Promise<CurrentUser[]> {
  if (!devAuthEnabled()) return [];

  const result = await pool().query<CurrentUser>(
    `SELECT id, name, email FROM users WHERE deactivated_at IS NULL ORDER BY created_at`,
  );
  return result.rows;
}

/**
 * Throws rather than returning null. Mutations must never run without an actor
 * — an activity log with a null author is worse than no log at all, because it
 * looks trustworthy.
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("Not signed in. Run `npm run db:seed` to create the demo users.");
  }
  return user;
}
