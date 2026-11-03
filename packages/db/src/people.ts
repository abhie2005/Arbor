/**
 * Who the people of a workspace are, for a menu or for a label.
 *
 * **Both halves used to be `SELECT id, name FROM users`** with no workspace
 * join at all (D-130 made that provable; the five sites are listed in
 * `docs/STATUS.md`). It answered correctly for as long as every person in the
 * database was a member of the one workspace, which is to say it answered
 * correctly by accident.
 *
 * **The audience is the argument, because the two questions have different
 * answers.** A control that writes a person onto something — an assignee, a
 * watcher, a goal's owner — may only offer somebody a person would mean:
 * `offerable`. Anything that turns an id already stored into a name must
 * resolve *everyone*, including the deactivated and the robots, or a card
 * legend and a table cell print a uuid at somebody: `everyone`.
 *
 * **A service account is a real `users` row** (D-126), so it is a member like
 * any other and `everyone` includes it. What may name one deliberately is a
 * rule: `loadFilterOptions` feeds the automations screen's own target menu as
 * well as a view's filter bar, so it asks for `everyone` — "assign to the
 * workspace's automation account" stays expressible, and "assign to it by
 * hand" is not offered anywhere.
 *
 * The membership join also fixes a symptom that read as a duplicate: an
 * automation account's synthetic email carries the workspace id, so re-seeding
 * leaves the previous one in `users` forever. It has no membership in the new
 * workspace, so it is simply not a person here any more.
 */
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";

/** Declared locally, as every other module here does (`documents.ts`). */
type Connection = Pool | PoolClient;

export type Audience = "offerable" | "everyone";

export interface WorkspacePerson {
  id: string;
  name: string;
}

export async function peopleIn(
  workspaceId: string,
  audience: Audience,
  connection: Connection = pool(),
): Promise<WorkspacePerson[]> {
  // Deactivated is excluded from an offer for the reason D-083 gives about a
  // mention: a name nobody should be able to newly choose, whose label on what
  // already names them has to go on working.
  const offerOnly = audience === "offerable" ? "AND u.kind = 'person' AND u.deactivated_at IS NULL" : "";

  const result = await connection.query<WorkspacePerson>(
    `SELECT u.id, u.name
     FROM users u JOIN memberships m ON m.user_id = u.id AND m.workspace_id = $1
     WHERE true ${offerOnly}
     ORDER BY u.name`,
    [workspaceId],
  );

  return result.rows;
}

/**
 * The names of ids already in hand.
 *
 * A person on a task has to be labelled whether or not they may be offered —
 * a deactivated assignee, or the robot a rule assigned. Not workspace-scoped
 * and it does not need to be: the ids come from the task's own rows, so
 * anybody who may read the task may already read who is on it.
 */
export async function namesFor(
  ids: string[],
  connection: Connection = pool(),
): Promise<WorkspacePerson[]> {
  if (ids.length === 0) return [];

  const result = await connection.query<WorkspacePerson>(
    `SELECT id, name FROM users WHERE id = ANY($1::uuid[]) ORDER BY name`,
    [ids],
  );

  return result.rows;
}

/**
 * The service accounts previous runs left behind (D-139).
 *
 * The paragraph above describes the symptom — a re-seed leaves the old
 * automation account in `users` forever — and this is what removes it. They
 * had reached **24 against 5 people** on this machine, one per token ever
 * minted by a seed or a check run, so the dev switcher's dropdown was mostly
 * robots with the same name.
 *
 * **No membership is the whole test, and it is not a heuristic.** A principal
 * reaches containers by joining `access_index`, which is built from
 * memberships and grants, so a service account in no workspace can reach
 * nothing at all — it is not disabled, it is inert. Dropping a workspace takes
 * its memberships and its tokens with it and leaves the account, which is the
 * only way one gets into this state.
 *
 * **The two guards are what make it a cleanup rather than a risk**, and both
 * are checked:
 *
 * - `activity.actor_id` is **SET NULL**, so deleting an account that wrote
 *   history would quietly erase who did it. "A rule did this" becoming nobody
 *   is a worse outcome than a stale row in a dropdown.
 * - An account that still has a token is one somebody may still be holding,
 *   whatever its memberships say. A token outliving its workspace is a
 *   separate bug and this must not hide it.
 *
 * Deliberately **not** scoped to a workspace: an orphan belongs to none, which
 * is what makes it an orphan. It is called from the seed rather than on a
 * timer, because that is the thing that creates them.
 */
export async function sweepOrphanedServiceAccounts(
  connection: Connection = pool(),
): Promise<number> {
  const result = await connection.query(
    `DELETE FROM users u
      WHERE u.kind = 'service'
        AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM activity a    WHERE a.actor_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM api_tokens t  WHERE t.principal_id = u.id)`,
  );
  return result.rowCount ?? 0;
}
