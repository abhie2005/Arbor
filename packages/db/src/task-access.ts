import { type Permission, satisfies } from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";

/**
 * Can this viewer do this to this task?
 *
 * **Reads were scoped and writes were not.** Every view query joins
 * `access_index` (ADR 3), so a task in a list you cannot reach never appears on
 * a screen. But the server actions that *change* a task only ever established
 * who the actor was — they never asked whether that actor could reach the task
 * they had named. That was survivable while the only way to name a task was to
 * click a row you could already see. A task detail page at a URL ends that:
 * an id is now something you can type.
 *
 * This is the same join the compiler does, for one task instead of a page of
 * them, and it is deliberately in the data layer rather than the web app — the
 * worker will apply operations too, and a check that lives beside the caller is
 * a check the next caller does not have.
 *
 * **Nothing here trusts a workspace id from the caller.** The task's own row
 * supplies it, because a viewer who can name a task in another workspace is
 * exactly the case this is meant to catch.
 */

export class AccessDenied extends Error {}

type Connection = Pool | PoolClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every id here arrives from a client. A malformed one is a miss, not a 500. */
function isId(value: string): boolean {
  return UUID_RE.test(value);
}

export interface TaskAccess {
  taskId: string;
  workspaceId: string;
  homeListId: string;
  /** What the viewer holds on the task's home list, not what they asked for. */
  permission: Permission;
}

/**
 * What the viewer may do with a task, or null if they cannot reach it at all.
 *
 * Null covers three cases that must stay indistinguishable to the caller: the
 * task never existed, it was deleted, and it exists in a list the viewer has no
 * grant on. Telling them apart is how a permission check becomes an existence
 * oracle — "no such task" and "not yours" are the same sentence, and a stranger
 * can enumerate neither.
 *
 * Status and custom fields resolve against the home list (see `tasks`), so
 * permission does too. A task shared into a second list is reachable through
 * that list's view, but its home list is what governs writing to it.
 */
export async function taskAccess(
  taskId: string,
  viewerId: string,
  connection: Connection = pool(),
): Promise<TaskAccess | null> {
  if (!isId(taskId) || !isId(viewerId)) return null;

  const result = await connection.query<{
    workspace_id: string;
    home_list_id: string;
    permission: Permission;
  }>(
    `SELECT t.workspace_id, t.home_list_id, ax.permission
     FROM tasks t
     JOIN access_index ax
       ON ax.list_id = t.home_list_id AND ax.principal_id = $2
     WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [taskId, viewerId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    taskId,
    workspaceId: row.workspace_id,
    homeListId: row.home_list_id,
    permission: row.permission,
  };
}

/**
 * The same, but throwing — for the actions, where continuing is never right.
 *
 * **Two different refusals, on purpose.** Unreachable is reported as gone,
 * because saying "you may not touch that" confirms the task exists to someone
 * who should not know. Reachable-but-insufficient says so plainly: the viewer
 * can already see the task, so there is nothing left to protect, and "it does
 * not exist" would be a lie about a row they are looking at.
 */
export async function requireTaskAccess(
  taskId: string,
  viewerId: string,
  need: Permission,
  connection: Connection = pool(),
): Promise<TaskAccess> {
  const access = await taskAccess(taskId, viewerId, connection);
  if (!access) throw new AccessDenied("That task no longer exists");

  if (!satisfies(access.permission, need)) {
    throw new AccessDenied(
      need === "manage"
        ? "You do not have permission to manage this task"
        : "You do not have permission to change this task",
    );
  }

  return access;
}

/**
 * Every task in a batch, in one query.
 *
 * `undo` is the reason this exists. It takes an array of operations *from the
 * client* and applies them, which makes it the widest write in the app: a
 * batch naming any task id at all would otherwise be applied on the strength of
 * being signed in. Checking each id in its own round trip would be correct and
 * slow; one query over the set is correct and not.
 *
 * A batch is refused whole. Applying the reachable half of an undo and dropping
 * the rest would half-restore a task, which is worse than refusing — and it
 * would tell the caller which ids were real.
 */
export async function requireTasksAccess(
  taskIds: readonly string[],
  viewerId: string,
  need: Permission,
  connection: Connection = pool(),
): Promise<void> {
  const wanted = [...new Set(taskIds)];
  if (wanted.length === 0) return;
  if (!isId(viewerId) || wanted.some((id) => !isId(id))) {
    throw new AccessDenied("That task no longer exists");
  }

  const result = await connection.query<{ id: string; permission: Permission }>(
    `SELECT t.id, ax.permission
     FROM tasks t
     JOIN access_index ax
       ON ax.list_id = t.home_list_id AND ax.principal_id = $2
     WHERE t.id = ANY($1) AND t.deleted_at IS NULL`,
    [wanted, viewerId],
  );

  const reachable = new Map(result.rows.map((row) => [row.id, row.permission]));

  for (const id of wanted) {
    const permission = reachable.get(id);
    if (!permission) throw new AccessDenied("That task no longer exists");
    if (!satisfies(permission, need)) {
      throw new AccessDenied("You do not have permission to change this task");
    }
  }
}

/**
 * What the viewer may do in a list.
 *
 * Creating a task names a container rather than a task, so it cannot go through
 * the checks above — and an unchecked create is how someone puts a row inside a
 * private list they cannot read.
 */
export async function listAccess(
  listId: string,
  viewerId: string,
  connection: Connection = pool(),
): Promise<Permission | null> {
  if (!isId(listId) || !isId(viewerId)) return null;

  const result = await connection.query<{ permission: Permission }>(
    `SELECT permission FROM access_index WHERE list_id = $1 AND principal_id = $2`,
    [listId, viewerId],
  );

  return result.rows[0]?.permission ?? null;
}

export async function requireListAccess(
  listId: string,
  viewerId: string,
  need: Permission,
  connection: Connection = pool(),
): Promise<Permission> {
  const permission = await listAccess(listId, viewerId, connection);
  if (!permission) throw new AccessDenied("That list no longer exists");

  if (!satisfies(permission, need)) {
    throw new AccessDenied("You do not have permission to change this list");
  }

  return permission;
}

/**
 * Ordered by privilege, so a minimum can be expressed as an index.
 *
 * This is a *workspace* role, which is a different axis from the container
 * permission above: a role says what you may do to the workspace's own
 * configuration, a permission says what you may reach inside its tree. A
 * member with `manage` on one list is not thereby allowed to delete the status
 * set every list shares.
 */
const ROLE_ORDER = ["guest", "limited_member", "member", "admin", "owner"] as const;

export type MemberRole = (typeof ROLE_ORDER)[number];

export async function workspaceRole(
  workspaceId: string,
  userId: string,
  connection: Connection = pool(),
): Promise<MemberRole | null> {
  if (!isId(workspaceId) || !isId(userId)) return null;

  const result = await connection.query<{ role: MemberRole }>(
    `SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );

  return result.rows[0]?.role ?? null;
}

/**
 * Workspace configuration is administered, not edited.
 *
 * Grants, container privacy, status sets, custom fields and task types all
 * change what *everyone* in the workspace sees, and none of them is scoped to a
 * container the way a task is. Until there is a rule that can answer "may this
 * person manage this space", the honest boundary is the workspace role.
 *
 * **This is deliberately blunter than it should be** (D-081). The right answer
 * is a per-container permission that a space's owner also holds, so a team lead
 * can share their own space without being a workspace admin. That needs
 * `resolveAccess` to emit container rows as well as list rows, which is a
 * change to the pure rule and its tests. Blunt and closed beats precise and
 * open.
 */
export async function requireWorkspaceRole(
  workspaceId: string,
  userId: string,
  need: MemberRole,
  connection: Connection = pool(),
): Promise<MemberRole> {
  const role = await workspaceRole(workspaceId, userId, connection);
  if (!role || ROLE_ORDER.indexOf(role) < ROLE_ORDER.indexOf(need)) {
    throw new AccessDenied(
      need === "admin"
        ? "Only a workspace admin can change this"
        : "You do not have permission to change this",
    );
  }
  return role;
}

export interface ViewAccess {
  viewId: string;
  workspaceId: string;
  parentId: string | null;
  /** Set means the view belongs to one person and only they may change it. */
  ownerId: string | null;
}

/**
 * Who may change a saved view.
 *
 * Two rules, because a view is two different things depending on `ownerId`. A
 * **personal** view is one person's, and nobody else may rename, redefine or
 * delete it — not even a workspace admin, because the point of a personal view
 * is that it is invisible to everyone else, and a control that can edit what it
 * cannot see is not a control anyone can reason about. A **shared** view is
 * part of the container, so it takes the container's `edit` permission — the
 * same one required to change a task there.
 *
 * A workspace-wide view has no parent container to check against, so it falls
 * back to the workspace role: there is no smaller thing to scope it to.
 */
export async function requireViewAccess(
  viewId: string,
  userId: string,
  connection: Connection = pool(),
): Promise<ViewAccess> {
  if (!isId(viewId) || !isId(userId)) throw new AccessDenied("That view no longer exists");

  const result = await connection.query<{
    workspace_id: string;
    parent_id: string | null;
    owner_id: string | null;
  }>(`SELECT workspace_id, parent_id, owner_id FROM views WHERE id = $1`, [viewId]);

  const row = result.rows[0];
  if (!row) throw new AccessDenied("That view no longer exists");

  const access: ViewAccess = {
    viewId,
    workspaceId: row.workspace_id,
    parentId: row.parent_id,
    ownerId: row.owner_id,
  };

  if (row.owner_id) {
    if (row.owner_id !== userId) throw new AccessDenied("That view no longer exists");
    return access;
  }

  if (!row.parent_id) {
    await requireWorkspaceRole(row.workspace_id, userId, "admin", connection);
    return access;
  }

  await requireListAccess(row.parent_id, userId, "edit", connection);
  return access;
}
