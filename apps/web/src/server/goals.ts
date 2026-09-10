import "server-only";

import { type GoalRecord, listGoals, loadContainerTree, pool } from "@arbor/db";
import { cache } from "react";

/**
 * The goals screen's data.
 *
 * Thin over `listGoals`, which does the interesting part — running each
 * rollup's definition through the compiler as the goal's owner (D-102). What
 * this adds is the two lists the form needs: who can own a goal, and what a
 * rollup can be scoped to.
 */

export interface GoalScope {
  id: string;
  name: string;
  kind: "list" | "space";
}

export interface GoalsPage {
  goals: GoalRecord[];
  people: { id: string; name: string }[];
  /** Somewhere a rollup can point. Spaces and lists; folders are not offered. */
  scopes: GoalScope[];
}

export const loadGoalsPage = cache(
  async (workspaceId: string, includeArchived = false): Promise<GoalsPage> => {
    const [goals, people, containers] = await Promise.all([
      listGoals(workspaceId, { includeArchived }),
      pool().query<{ id: string; name: string }>(
        `SELECT id, name FROM users WHERE deactivated_at IS NULL ORDER BY name`,
      ),
      loadContainerTree(workspaceId),
    ]);

    /**
     * **Not permission-scoped, and it cannot be.** The picker is choosing what
     * a goal *measures*, and the measurement runs as the goal's owner rather
     * than as whoever is filling in the form — offering only the lists the
     * author can see would hide exactly the ones an owner with wider access is
     * able to count. The scope names a container; the number it produces is
     * still the owner's (D-102).
     */
    const scopes: GoalScope[] = [...containers.values()]
      .filter((node) => node.kind === "list" || node.kind === "space")
      .map((node) => ({ id: node.id, name: node.name, kind: node.kind as "list" | "space" }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { goals, people: people.rows, scopes };
  },
);
