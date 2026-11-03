"use client";

import { useTransition } from "react";

import { switchWorkspace } from "@/server/actions";

/**
 * Which workspace you are looking at (D-137).
 *
 * Rendered only when there is a choice to make — a person in one workspace
 * sees its name, because a select with one option is a control that cannot do
 * anything. That is why this takes the list rather than reading it: the
 * sidebar already has it, and whether to render a switcher at all is the
 * sidebar's decision.
 *
 * Deliberately not the dev user switcher's twin. That one is a debug control
 * and looks like one (D-034); this is an ordinary piece of the product, so it
 * reads as the workspace name until you click it.
 */
export function WorkspaceSwitcher({
  workspaces,
  currentId,
}: {
  workspaces: { id: string; name: string }[];
  currentId: string;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <select
      className="ws-switch"
      value={currentId}
      disabled={pending}
      aria-label="Which workspace to show"
      onChange={(e) => {
        const id = e.target.value;
        if (id !== currentId) startTransition(() => void switchWorkspace(id));
      }}
    >
      {workspaces.map((workspace) => (
        <option key={workspace.id} value={workspace.id}>
          {workspace.name}
        </option>
      ))}
    </select>
  );
}
