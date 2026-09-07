/**
 * Who can reach which list.
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
 * 1. An **open** list is reachable by every member of the workspace, at a
 *    permission derived from their role.
 * 2. A list is **effectively private** if it or any ancestor is private
 *    (`isEffectivelyPrivate`), and then only an explicit grant reaches it -
 *    on the list itself or on anything above it.
 * 3. Whatever applies, the **strongest permission wins**.
 *
 * Everything else here is a consequence of those three.
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
  listId: string;
  permission: Permission;
}

export function strongest(a: Permission, b: Permission): Permission {
  return PERMISSIONS.indexOf(a) >= PERMISSIONS.indexOf(b) ? a : b;
}

/**
 * The complete access index for a workspace.
 *
 * Returns one row per (user, list) they can reach, sorted so two runs over the
 * same inputs produce identical output - a rebuild that reorders rows for no
 * reason makes every diff of this table unreadable.
 *
 * **The owner is the exception to privacy.** An owner reaches every list in the
 * workspace, private or not, because they are the account holder and the
 * alternative is a workspace whose owner can be locked out of their own data.
 * An **admin is not** an exception: a private space an admin can silently read
 * is not private, and "admin" is a permission to administer, not to read.
 */
export function resolveAccess(inputs: AccessInputs): AccessRow[] {
  const { containers, grants, members, groupMembers } = inputs;

  const byId = indexById(containers);
  const lists = containers.filter((container) => container.kind === "list");

  const membersByUser = new Map(members.map((member) => [member.userId, member]));
  const usersInGroup = new Map<string, string[]>();
  for (const link of groupMembers) {
    usersInGroup.set(link.groupId, [...(usersInGroup.get(link.groupId) ?? []), link.userId]);
  }

  // A grant reaches a list when it sits on the list or anywhere above it, so it
  // is indexed by container and the walk happens once per list.
  const grantsByContainer = new Map<string, AccessGrant[]>();
  for (const grant of grants) {
    grantsByContainer.set(grant.containerId, [
      ...(grantsByContainer.get(grant.containerId) ?? []),
      grant,
    ]);
  }

  const rows = new Map<string, AccessRow>();
  const add = (principalId: string, listId: string, permission: Permission) => {
    // Only real members of the workspace end up in the index. A grant to
    // someone who has been removed is inert rather than an error: revoking
    // membership must not require finding every grant they were ever given.
    if (!membersByUser.has(principalId)) return;

    const key = `${principalId} ${listId}`;
    const existing = rows.get(key);
    rows.set(key, {
      principalId,
      listId,
      permission: existing ? strongest(existing.permission, permission) : permission,
    });
  };

  for (const list of lists) {
    const chain = ancestorsOf(list.id, byId);
    const restricted = isEffectivelyPrivate(list.id, byId);

    if (restricted) {
      // Owners keep reaching everything; see the note above.
      for (const member of members) {
        if (member.role === "owner") add(member.userId, list.id, "manage");
      }
    } else {
      for (const member of members) {
        const baseline = ROLE_BASELINE[member.role];
        if (baseline) add(member.userId, list.id, baseline);
      }
    }

    // Grants apply either way: they let a guest into an open list, and they
    // raise one member's permission on one list without touching the rest.
    for (const container of chain) {
      for (const grant of grantsByContainer.get(container.id) ?? []) {
        if (grant.principalKind === "user") {
          add(grant.principalId, list.id, grant.permission);
          continue;
        }
        for (const userId of usersInGroup.get(grant.principalId) ?? []) {
          add(userId, list.id, grant.permission);
        }
      }
    }
  }

  return [...rows.values()].sort(
    (a, b) => a.principalId.localeCompare(b.principalId) || a.listId.localeCompare(b.listId),
  );
}

/**
 * The lists a rebuild has to recompute after a change to one container.
 *
 * Every list at or below it - a grant on a space changes access to everything
 * under it, and so does making that space private. Callers that would rather
 * rebuild the whole workspace may; this exists so they do not have to.
 */
export function affectedLists(
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

  const lists: string[] = [];
  const queue: ContainerNode[] = [root];

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) break;
    if (node.kind === "list") lists.push(node.id);
    queue.push(...(childrenOf.get(node.id) ?? []));
  }

  return lists.sort();
}
