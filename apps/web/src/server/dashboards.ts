import "server-only";

import {
  type DashboardRecord,
  type ResolvedCard,
  listDashboards,
  loadContainerTree,
  pool,
  resolveCards,
} from "@arbor/db";
import { cache } from "react";

/**
 * The dashboards screen's data.
 *
 * Thin over `listDashboards` and `resolveCards`, which do the interesting part
 * — running each card's definition through the compiler as the *viewer*
 * (D-105). What this adds is the lookups a chart needs to print words instead
 * of ids, loaded once for the screen rather than once per card.
 *
 * **The renderer receives values, never ids plus the maps to join them.** Same
 * boundary the table cells draw (D-059): sending the maps would ship every
 * status and every person in the workspace to the browser to label a handful of
 * bars, and a client that joins ids to names is a second place where a missing
 * name has to be handled.
 */

export interface DashboardScope {
  id: string;
  name: string;
  kind: "list" | "space";
}

export interface DashboardView extends DashboardRecord {
  resolved: ResolvedCard[];
}

export interface DashboardsPage {
  dashboards: DashboardView[];
  scopes: DashboardScope[];
}

export const loadDashboardsPage = cache(
  async (workspaceId: string, viewerId: string): Promise<DashboardsPage> => {
    const [dashboards, statuses, people, containers, taskTypes] = await Promise.all([
      listDashboards(workspaceId, viewerId),
      pool().query<{ id: string; name: string; color: string }>(
        `SELECT s.id, s.name, s.color FROM statuses s
         JOIN status_sets ss ON ss.id = s.status_set_id
         WHERE ss.workspace_id = $1`,
        [workspaceId],
      ),
      pool().query<{ id: string; name: string }>(
        `SELECT id, name FROM users WHERE deactivated_at IS NULL`,
      ),
      loadContainerTree(workspaceId),
      pool().query<{ id: string; name: string }>(
        `SELECT id, name FROM task_types WHERE workspace_id = $1`,
        [workspaceId],
      ),
    ]);

    const labels = {
      statuses: new Map(
        statuses.rows.map((row) => [row.id, { name: row.name, color: row.color }]),
      ),
      people: new Map(people.rows.map((row) => [row.id, row.name])),
      containers: new Map([...containers.values()].map((node) => [node.id, node.name])),
      taskTypes: new Map(taskTypes.rows.map((row) => [row.id, row.name])),
    };

    const resolvedAll = await Promise.all(
      dashboards.map((dashboard) =>
        resolveCards(dashboard.cards, { workspaceId, viewerId }, labels),
      ),
    );

    return {
      dashboards: dashboards.map((dashboard, index) => ({
        ...dashboard,
        resolved: resolvedAll[index]!,
      })),
      /**
       * Where a card can point.
       *
       * Only the lists this viewer can reach, unlike the goal form's picker —
       * and the difference follows from D-105. A goal's rollup is counted as
       * its owner, so offering only what the author can see would hide lists an
       * owner could legitimately count; a card is counted as whoever is reading
       * it, so a scope the author cannot reach is a card that would read zero
       * for them and be indistinguishable from an empty list.
       */
      scopes: [...containers.values()]
        .filter((node) => node.kind === "list" || node.kind === "space")
        .map((node) => ({ id: node.id, name: node.name, kind: node.kind as "list" | "space" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
);
