/**
 * Who can reach which container.
 *
 * This is the calculation ADR 3 is built around. `grants` are the source of
 * truth and are cheap to write; `access_index` is what every task query joins
 * against, because answering "can this viewer see this task" by walking parents
 * costs one join per level of nesting on every query, for every viewer. This
 * module is the flattening in between - pure, so the rule that decides who sees
 * what can be tested without a database and cannot differ between the job that
 * rebuilds the index and anything else that asks.
 *
 * **The three rules.**
 *
 * 1. An **open** container is reachable by every member of the workspace, at a
 *    permission derived from their role.
 * 2. A container is **effectively private** if it or any ancestor is private
 *    (`isEffectivelyPrivate`), and then only an explicit grant reaches it -
 *    on the container itself or on anything above it.
 * 3. Whatever applies, the **strongest permission wins**.
 *
 * Everything else here is a consequence of those three.
 *
 * **A row per container, not per list** (D-108). The index held lists only,
 * because tasks live in lists and task queries were all it was built for. Three
 * features in a row then had to route around that: sharing became a workspace
 * role rather than a permission on the space being shared (D-081), a goal got
 * no privacy at all, and a space-scoped dashboard fell back to counting the
 * whole workspace because there was no row to join for a space. Emitting a row
 * for every container costs one row per (member, space or folder) — units of
 * hundreds against the thousands already there — and turns all three of those
 * into the same join every task query already does.
 *
 * **A container row means "may act on this container", not "may see it in the
 * tree".** Grants reach downward, so a grant on one list inside a private space
 * opens the list and not the space above it. Rendering a sidebar path to that
 * list is a separate question with a different answer, and answering it here by
 * quietly adding ancestors would hand out `manage` on a private space to
 * everyone who was shared one list in it.
 */

import { type ContainerNode, ancestorsOf, indexById, isEffectivelyPrivate } from "./hierarchy";

/** Mirrors the `permission` enum, weakest first. The order is the comparison. */
export const PERMISSIONS = ["view", "comment", "edit", "manage"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Mirrors the `member_role` enum. */
export type MemberRole = "owner" | "admin" | "member" | "limited_member" | "guest";

/**
 * What a role gets on a list nobody has restricted.
 *
 * A guest gets nothing: a guest is someone invited to specific things, so
 * "everything not marked private" is precisely the wrong default for them. The
 * rest map onto what their role means - a `limited_member` may comment but not
 * edit, which is the only reason that role exists.
 */
export const ROLE_BASELINE: Record<MemberRole, Permission | null> = {
  owner: "manage",
  admin: "manage",
  member: "edit",
  limited_member: "comment",
  guest: null,
};

export interface AccessGrant {
  containerId: string;
  principalKind: "user" | "group";
  /** A user id, or a group id when `principalKind` is "group". */
  principalId: string;
  permission: Permission;
}

export interface WorkspaceMember {
  userId: string;
  role: MemberRole;
}

export interface GroupMember {
  groupId: string;
  userId: string;
}

export interface AccessInputs {
  containers: readonly ContainerNode[];
  grants: readonly AccessGrant[];
  members: readonly WorkspaceMember[];
  groupMembers: readonly GroupMember[];
}

/** One row of the materialized index. */
export interface AccessRow {
  principalId: string;
  /** Any container — a list for a task query, a space or folder for sharing. */
  containerId: string;
  permission: Permission;
}

export function strongest(a: Permission, b: Permission): Permission {
  return PERMISSIONS.indexOf(a) >= PERMISSIONS.indexOf(b) ? a : b;
}

/**
 * Does the permission someone holds reach the one an action needs?
 *
 * The ladder is `view < comment < edit < manage`, so this is an index
 * comparison. It is a named function rather than an inline comparison at each
 * call site because the ladder is the kind of thing that gets reimplemented
 * backwards once, in one place, and then guards nothing.
 */
export function satisfies(have: Permission, need: Permission): boolean {
  return PERMISSIONS.indexOf(have) >= PERMISSIONS.indexOf(need);
}

/**
 * The complete access index for a workspace.
 *
 * Returns one row per (user, container) they can reach, sorted so two runs over
 * the same inputs produce identical output - a rebuild that reorders rows for no
 * reason makes every diff of this table unreadable.
 *
 * **The owner is the exception to privacy.** An owner reaches every container in
 * the workspace, private or not, because they are the account holder and the
 * alternative is a workspace whose owner can be locked out of their own data.
 * An **admin is not** an exception: a private space an admin can silently read
 * is not private, and "admin" is a permission to administer, not to read.
 */
export function resolveAccess(inputs: AccessInputs): AccessRow[] {
  const { containers, grants, members, groupMembers } = inputs;

  const byId = indexById(containers);

  const membersByUser = new Map(members.map((member) => [member.userId, member]));
  const usersInGroup = new Map<string, string[]>();
  for (const link of groupMembers) {
    usersInGroup.set(link.groupId, [...(usersInGroup.get(link.groupId) ?? []), link.userId]);
  }

  // A grant reaches a container when it sits on that container or anywhere above
  // it, so grants are indexed by container and the walk happens once per row.
  const grantsByContainer = new Map<string, AccessGrant[]>();
  for (const grant of grants) {
    grantsByContainer.set(grant.containerId, [
      ...(grantsByContainer.get(grant.containerId) ?? []),
      grant,
    ]);
  }

  const rows = new Map<string, AccessRow>();
  const add = (principalId: string, containerId: string, permission: Permission) => {
    // Only real members of the workspace end up in the index. A grant to
    // someone who has been removed is inert rather than an error: revoking
    // membership must not require finding every grant they were ever given.
    if (!membersByUser.has(principalId)) return;

    const key = `${principalId} ${containerId}`;
    const existing = rows.get(key);
    rows.set(key, {
      principalId,
      containerId,
      permission: existing ? strongest(existing.permission, permission) : permission,
    });
  };

  for (const target of containers) {
    const chain = ancestorsOf(target.id, byId);
    const restricted = isEffectivelyPrivate(target.id, byId);

    if (restricted) {
      // Owners keep reaching everything; see the note above.
      for (const member of members) {
        if (member.role === "owner") add(member.userId, target.id, "manage");
      }
    } else {
      for (const member of members) {
        const baseline = ROLE_BASELINE[member.role];
        if (baseline) add(member.userId, target.id, baseline);
      }
    }

    // Grants apply either way: they let a guest into an open list, and they
    // raise one member's permission on one container without touching the rest.
    for (const container of chain) {
      for (const grant of grantsByContainer.get(container.id) ?? []) {
        if (grant.principalKind === "user") {
          add(grant.principalId, target.id, grant.permission);
          continue;
        }
        for (const userId of usersInGroup.get(grant.principalId) ?? []) {
          add(userId, target.id, grant.permission);
        }
      }
    }
  }

  return [...rows.values()].sort(
    (a, b) => a.principalId.localeCompare(b.principalId) || a.containerId.localeCompare(b.containerId),
  );
}

/**
 * The containers a rebuild has to recompute after a change to one of them.
 *
 * Everything at or below it, itself included - a grant on a space changes access
 * to everything under it, and so does making that space private. Callers that
 * would rather rebuild the whole workspace may; this exists so they do not have
 * to.
 */
export function affectedContainers(
  containerId: string,
  containers: readonly ContainerNode[],
): string[] {
  const byId = indexById(containers);
  const root = byId.get(containerId);
  if (!root) return [];

  const childrenOf = new Map<string, ContainerNode[]>();
  for (const container of containers) {
    if (!container.parentId) continue;
    childrenOf.set(container.parentId, [...(childrenOf.get(container.parentId) ?? []), container]);
  }

  const found: string[] = [];
  const queue: ContainerNode[] = [root];

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) break;
    found.push(node.id);
    queue.push(...(childrenOf.get(node.id) ?? []));
  }

  return found.sort();
}
