"use client";

import { MIN_PASSWORD_LENGTH } from "@arbor/core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { signInAction } from "@/server/auth-actions";

/**
 * The sign-in form.
 *
 * One error message for every failure, because the server deliberately gives
 * only one: telling "no such account" apart from "wrong password" is an
 * account enumeration oracle. The form does not improve on that by guessing.
 *
 * The only client-side check is length, and it is there to save a round trip
 * rather than to enforce anything — the policy lives in @arbor/core and runs on
 * the server, which is the copy that counts.
 */
export function SignInForm({ demoPassword }: { demoPassword: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await signInAction(email, password);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/");
      router.refresh();
    });
  }

  return (
    <form
      className="login-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="login-field">
        Email
        <input
          className="settings-input"
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>

      <label className="login-field">
        Password
        <input
          className="settings-input"
          type="password"
          autoComplete="current-password"
          minLength={MIN_PASSWORD_LENGTH}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>

      <button className="login-submit" type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>

      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}

      {demoPassword ? (
        <p className="login-hint">
          Demo workspace: sign in as <code>avery@example.com</code> with{" "}
          <code>{demoPassword}</code>. Any of the seeded users works.
        </p>
      ) : null}
    </form>
  );
}
