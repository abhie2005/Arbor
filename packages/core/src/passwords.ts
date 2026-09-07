/**
 * What counts as an acceptable password.
 *
 * Pure and in core so the same rule runs in the form before submitting, in the
 * server action, and in the seed - rather than three nearly-identical regexes
 * that disagree about the edge cases.
 *
 * **Length, and almost nothing else.** Composition rules ("one uppercase, one
 * digit, one symbol") push people towards `Password1!` and are no longer
 * recommended by anyone who measures outcomes; length is what actually costs an
 * attacker. The other two rules here exist because they catch real mistakes: a
 * password that is only whitespace, and one long enough to be a denial of
 * service against the hash function.
 */

export class PasswordError extends Error {}

export const MIN_PASSWORD_LENGTH = 10;

/**
 * scrypt runs over the whole input, so an unbounded password is an unbounded
 * amount of work for anyone who can hit the login form.
 */
export const MAX_PASSWORD_LENGTH = 200;

export function assertPasswordPolicy(password: unknown): string {
  if (typeof password !== "string" || password.trim() === "") {
    throw new PasswordError("A password is required");
  }

  // Not trimmed: leading and trailing spaces are legitimate characters in a
  // password, and silently removing them means a password manager's value
  // stops matching what was stored.
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordError(
      `A password needs at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordError(
      `A password is limited to ${MAX_PASSWORD_LENGTH} characters`,
    );
  }

  return password;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Enough to reject a typo, not an attempt to decide what an address may look
 * like. The only real test of an address is sending to it.
 */
export function normalizeEmail(email: unknown): string {
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    throw new PasswordError("That does not look like an email address");
  }
  return email.trim().toLowerCase();
}
