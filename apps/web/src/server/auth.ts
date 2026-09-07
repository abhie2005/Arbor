import "server-only";

import { type SessionUser, pool, sessionUser } from "@arbor/db";
import { cookies } from "next/headers";

/**
 * Identity.
 *
 * Sessions are real now: the cookie holds a token, the token hashes to a row in
 * `sessions`, and that row names the user. What has not changed is the rule
 * that made the swap cheap — **application code only ever calls
 * `getCurrentUser()`**. Nothing else reads a cookie or knows how identity is
 * established, which is why replacing the switcher touched this file and
 * almost nothing else.
 *
 * The development switcher (D-034) survives *underneath* real sessions rather
 * than instead of them: it applies only when its cookie is explicitly set, so a
 * browser with no cookies is signed out and sees the login screen. Being able
 * to become another user without their password is worth keeping for a demo
 * workspace, and it is gated on `devAuthEnabled()`.
 */

export const SESSION_COOKIE = "arbor_session";
export const DEV_USER_COOKIE = "arbor_dev_user";

export type CurrentUser = SessionUser;

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
  const store = await cookies();

  const fromSession = await sessionUser(store.get(SESSION_COOKIE)?.value);
  if (fromSession) return fromSession;

  if (!devAuthEnabled()) return null;

  // Explicitly set only. Falling back to "the first user" when no cookie is
  // present would mean nobody is ever signed out in development, and a login
  // screen that cannot be reached is a login screen nobody tests.
  const selected = store.get(DEV_USER_COOKIE)?.value;
  if (!selected || !UUID_RE.test(selected)) return null;

  const result = await pool().query<CurrentUser>(
    `SELECT id, name, email FROM users WHERE id = $1 AND deactivated_at IS NULL`,
    [selected],
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
  if (!user) throw new Error("Not signed in");
  return user;
}
