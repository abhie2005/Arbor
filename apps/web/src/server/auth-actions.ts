"use server";

import { signIn, signOut } from "@arbor/db";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { DEV_USER_COOKIE, SESSION_COOKIE, devAuthEnabled } from "./auth";

/**
 * Signing in and out.
 *
 * The cookie is `httpOnly` and `sameSite: lax`: script on the page has no
 * reason to read a session token, and `lax` is what lets someone follow a link
 * into the app while still refusing a cross-site form post.
 *
 * `secure` follows the environment rather than being hard-coded, because a
 * self-hoster running on plain http behind their own network would otherwise
 * get a cookie the browser silently discards, and "login does nothing" is a
 * miserable thing to debug.
 */

export type SignInResult = { ok: true } | { ok: false; error: string };

export async function signInAction(email: string, password: string): Promise<SignInResult> {
  const store = await cookies();
  const headerList = await headers();

  try {
    const { token } = await signIn(email, password, {
      userAgent: headerList.get("user-agent"),
      ip: headerList.get("x-forwarded-for"),
    });

    store.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });

    // A stale switcher cookie would otherwise outrank nothing but would still
    // be there after signing out again.
    store.delete(DEV_USER_COOKIE);

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not sign in" };
  }
}

export async function signOutAction(): Promise<void> {
  const store = await cookies();

  // Deleted from the database as well as the browser: a cookie cleared only on
  // the client is still a live session for anyone who copied the token.
  await signOut(store.get(SESSION_COOKIE)?.value);

  store.delete(SESSION_COOKIE);
  if (devAuthEnabled()) store.delete(DEV_USER_COOKIE);

  redirect("/login");
}
