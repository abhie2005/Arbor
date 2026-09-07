"use client";

import { PERMISSIONS, type Permission } from "@arbor/core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  rebuildAccessAction,
  setPrivacyAction,
  shareContainerAction,
  unshareContainerAction,
} from "@/server/access-actions";

/**
 * Sharing one container.
 *
 * The panel shows inherited grants alongside a container's own, because a panel
 * that lists only its own tells someone their list is unshared while the space
 * above it is open to everyone. An inherited row is shown with where it came
 * from and cannot be removed here — the fix for "too many people can see this"
 * is either a grant on this container or a change further up, and pretending
 * otherwise would make a remove button that silently does nothing.
 */

export interface ShareRow {
  containerId: string;
  containerName: string;
  principalKind: "user" | "group";
  principalId: string;
  principalName: string;
  permission: Permission;
  inherited: boolean;
}

export interface Principal {
  id: string;
  name: string;
  kind: "user" | "group";
}

export interface ContainerSummary {
  id: string;
  name: string;
  kind: "space" | "folder" | "list";
  depth: number;
  isPrivate: boolean;
  /** True when an ancestor is private, so this one is closed without saying so. */
  inheritsPrivacy: boolean;
  /** How many people can reach this container's lists, from the index. */
  reach: number;
}

export function SharingPanel({
  containers,
  selected,
  grants,
  principals,
}: {
  containers: ContainerSummary[];
  selected: ContainerSummary | null;
  grants: ShareRow[];
  principals: Principal[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<string>(principals[0]?.id ?? "");
  const [permission, setPermission] = useState<Permission>("edit");

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  const principal = principals.find((candidate) => candidate.id === addingTo);
  const already = new Set(grants.filter((g) => !g.inherited).map((g) => g.principalId));

  return (
    <div className="sharing" data-pending={pending || undefined}>
      <div className="sharing-tree">
        {containers.map((container) => (
          <a
            key={container.id}
            className="sharing-node"
            style={{ paddingLeft: `calc(var(--space-3) + ${container.depth} * 14px)` }}
            href={`/settings/sharing?container=${container.id}`}
            aria-current={container.id === selected?.id ? "page" : undefined}
          >
            <span className="sharing-kind">
              {container.kind === "space" ? "◈" : container.kind === "folder" ? "▸" : "▤"}
            </span>
            {container.name}
            {container.isPrivate ? <span className="sharing-lock" title="Private">•</span> : null}
            {/* The number that matters: how many people this actually reaches,
                read from the index rather than counted from the grants. */}
            <span className="sharing-reach">{container.reach}</span>
          </a>
        ))}
      </div>

      <div className="sharing-detail">
        {!selected ? (
          <p className="settings-note">Pick a container to see who can reach it.</p>
        ) : (
          <>
            <h3>{selected.name}</h3>

            <label className="sharing-private">
              <input
                type="checkbox"
                checked={selected.isPrivate}
                disabled={selected.inheritsPrivacy}
                onChange={() => run(() => setPrivacyAction(selected.id, !selected.isPrivate))}
              />
              Private — only people with a grant can reach it
            </label>

            {selected.inheritsPrivacy ? (
              <p className="settings-note">
                Already private because something above it is. Privacy is inherited downward and
                cannot be loosened here.
              </p>
            ) : null}

            <table className="sharing-grants">
              <tbody>
                {grants.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="settings-note">
                      No grants. {selected.isPrivate || selected.inheritsPrivacy
                        ? "Nobody but the workspace owner can reach this."
                        : "Everyone in the workspace can reach it, at their role's permission."}
                    </td>
                  </tr>
                ) : (
                  grants.map((grant) => (
                    <tr key={`${grant.containerId}-${grant.principalId}`}>
                      <td>
                        {grant.principalName}
                        {grant.principalKind === "group" ? (
                          <span className="sharing-tag">group</span>
                        ) : null}
                      </td>
                      <td>
                        {grant.permission}
                        {grant.inherited ? (
                          <span className="sharing-tag">from {grant.containerName}</span>
                        ) : null}
                      </td>
                      <td>
                        {grant.inherited ? null : (
                          <button
                            type="button"
                            className="sharing-remove"
                            onClick={() =>
                              run(() =>
                                unshareContainerAction(
                                  grant.containerId,
                                  grant.principalKind,
                                  grant.principalId,
                                ),
                              )
                            }
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            <div className="sharing-add">
              <select
                className="settings-input"
                value={addingTo}
                onChange={(event) => setAddingTo(event.target.value)}
              >
                {principals.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                    {candidate.kind === "group" ? " (group)" : ""}
                  </option>
                ))}
              </select>

              <select
                className="settings-input"
                value={permission}
                onChange={(event) => setPermission(event.target.value as Permission)}
              >
                {PERMISSIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => {
                  if (!principal) return;
                  run(() =>
                    shareContainerAction(selected.id, principal.kind, principal.id, permission),
                  );
                }}
              >
                {already.has(addingTo) ? "Change" : "Share"}
              </button>
            </div>

            {error ? (
              <p className="sharing-error" role="alert">
                {error}
              </p>
            ) : null}
          </>
        )}

        <div className="sharing-rebuild">
          <button type="button" onClick={() => run(() => rebuildAccessAction())}>
            Rebuild the access index
          </button>
          <span className="settings-note">
            Derived data — recomputing it is always safe, and is what the worker will do once there
            is one.
          </span>
        </div>
      </div>
    </div>
  );
}
