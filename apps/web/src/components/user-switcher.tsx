"use client";

import { useTransition } from "react";

import { switchUser } from "@/server/actions";
import { signOutAction } from "@/server/auth-actions";

/**
 * Development-only identity switcher (D-034).
 *
 * Deliberately looks like a debug control rather than a polished account menu —
 * it should be obvious at a glance that this is not real auth.
 */
export function UserSwitcher({
  users,
  currentId,
}: {
  users: { id: string; name: string }[];
  currentId: string;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <label className="switcher" title="Development only — not real authentication">
      <span className="switcher-tag">dev</span>
      <select
        value={currentId}
        disabled={pending}
        onChange={(e) => {
          const id = e.target.value;
          startTransition(() => void switchUser(id));
        }}
      >
        {users.map((user) => (
          <option key={user.id} value={user.id}>
            {user.name}
          </option>
        ))}
      </select>

      {/* Signing out is the only way back to the login screen, so it lives
          beside the thing that says who you are rather than in a menu. */}
      <button
        type="button"
        className="switcher-out"
        title="Sign out"
        aria-label="Sign out"
        disabled={pending}
        onClick={() => startTransition(() => void signOutAction())}
      >
        ⏻
      </button>
    </label>
  );
}
