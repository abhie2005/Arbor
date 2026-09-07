import { type ScryptOptions, createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { assertPasswordPolicy, normalizeEmail } from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";

/**
 * Passwords and sessions.
 *
 * **scrypt from the standard library, not argon2.** Argon2id is the better
 * function and every guide says so. It is also a native module, and this
 * project is meant to be cloned and run with Node and Docker and nothing else
 * - a compile step in the install is a real cost paid by every self-hoster, on
 * every architecture, forever. scrypt is memory-hard, it is in `node:crypto`,
 * and its parameters here are tuned to the same order of work. The stored
 * format names the algorithm, so moving to argon2id later is a rehash on next
 * sign-in rather than a migration.
 *
 * **A session token is never stored.** The row holds a SHA-256 of it, so a
 * database that leaks does not hand over live sessions - the same reason the
 * password is not stored. The token itself exists only in the cookie.
 */

// `promisify` picks the overload without options, which is the one this never
// uses - every call passes cost parameters.
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * ~64 MB and roughly 100 ms on this machine. High enough to matter to someone
 * with the hashes, low enough that a login does not feel broken.
 */
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, keylen: 64, maxmem: 128 * 2 ** 16 * 8 * 2 };

export class AuthError extends Error {}

type Connection = Pool | PoolClient;

export async function hashPassword(plain: string): Promise<string> {
  assertPasswordPolicy(plain);

  const salt = randomBytes(16);
  const derived = (await scryptAsync(plain, salt, SCRYPT.keylen, SCRYPT)) as Buffer;

  // Self-describing, so the parameters can change without orphaning old hashes.
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/**
 * Constant-time by construction: the comparison is `timingSafeEqual`, and a
 * malformed or absent hash still costs the same shape of work as a real one.
 */
export async function verifyPassword(plain: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;

  const [scheme, n, r, p, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !expected) return false;

  const expectedBytes = Buffer.from(expected, "base64");
  const derived = (await scryptAsync(plain, Buffer.from(salt, "base64"), expectedBytes.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(n) * Number(r) * 2,
  })) as Buffer;

  return derived.length === expectedBytes.length && timingSafeEqual(derived, expectedBytes);
}

export async function setPassword(
  userId: string,
  plain: string,
  connection: Connection = pool(),
): Promise<void> {
  const hash = await hashPassword(plain);
  const result = await connection.query(
    `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
    [hash, userId],
  );
  if (result.rowCount === 0) throw new AuthError(`User not found: ${userId}`);
}

const SESSION_BYTES = 32;
export const SESSION_DAYS = 30;

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

export interface SignInMeta {
  userAgent?: string | null;
  ip?: string | null;
}

/**
 * Checks an email and password, and opens a session.
 *
 * **One error message for every failure.** "No such account" and "wrong
 * password" told apart is an account enumeration oracle: it lets someone learn
 * which addresses are registered. Both paths also do the same work - an unknown
 * email still runs a verification against a dummy hash - so the *timing* does
 * not answer the question the message refuses to.
 */
export async function signIn(
  email: string,
  password: string,
  meta: SignInMeta = {},
  connection: Connection = pool(),
): Promise<{ token: string; user: SessionUser }> {
  const address = normalizeEmail(email);

  const found = await connection.query<{
    id: string;
    name: string;
    email: string;
    password_hash: string | null;
  }>(
    `SELECT id, name, email, password_hash FROM users
     WHERE lower(email) = $1 AND deactivated_at IS NULL`,
    [address],
  );

  const user = found.rows[0];
  const ok = await verifyPassword(
    typeof password === "string" ? password : "",
    user?.password_hash ?? DUMMY_HASH,
  );

  if (!user || !ok) throw new AuthError("That email and password do not match an account");

  const token = randomBytes(SESSION_BYTES).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await connection.query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, tokenHash(token), meta.userAgent ?? null, meta.ip ?? null, expires],
  );

  return { token, user: { id: user.id, name: user.name, email: user.email } };
}

/**
 * A real hash of a value nobody knows, so an unknown email costs the same as a
 * known one. Generated once per process rather than per request - deriving it
 * on every miss would be its own timing signal.
 */
const DUMMY_HASH =
  "scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" +
  "Ej4vJ3xkQ0dQe0lqWlZmMGtQTnlGdWxsT2ZOb3RoaW5nSGVyZUF0QWxsMDAwMDAwMDAwMDAwMDA=";

/** The user a session token belongs to, or null if it is unknown or expired. */
export async function sessionUser(
  token: string | null | undefined,
  connection: Connection = pool(),
): Promise<SessionUser | null> {
  if (!token) return null;

  const result = await connection.query<SessionUser>(
    `SELECT u.id, u.name, u.email
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.deactivated_at IS NULL`,
    [tokenHash(token)],
  );

  return result.rows[0] ?? null;
}

export async function signOut(
  token: string | null | undefined,
  connection: Connection = pool(),
): Promise<void> {
  if (!token) return;
  await connection.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash(token)]);
}

/** Every session for one user — for "sign out everywhere" and for revocation. */
export async function signOutEverywhere(
  userId: string,
  connection: Connection = pool(),
): Promise<number> {
  const result = await connection.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  return result.rowCount ?? 0;
}

/**
 * Expired rows are dead weight, not a security problem — `sessionUser` already
 * refuses them. This is housekeeping for the worker to call.
 */
export async function purgeExpiredSessions(connection: Connection = pool()): Promise<number> {
  const result = await connection.query(`DELETE FROM sessions WHERE expires_at <= now()`);
  return result.rowCount ?? 0;
}
