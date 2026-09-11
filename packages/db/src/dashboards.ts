import {
  type DashboardCard,
  type DashboardLayout,
  MAX_CARDS,
  chartDefinition,
  compileAggregate,
  compileGroupCounts,
  parseCard,
  parseLayout,
} from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";
import { type ConfigContext, ConfigError, inTransaction, logConfigChange, requireName } from "./config";
import { loadFieldCatalog } from "./fields";

/**
 * Dashboards, and the cards they are made of.
 *
 * **Every number on a dashboard is computed as the person looking at it**
 * (D-104) — the opposite of a goal's rollup, which is computed as the goal's
 * owner (D-102). The difference is not an inconsistency: a goal is a shared
 * commitment with an owner named on the row, so one number for everyone is the
 * point; a dashboard sits in a container, so the container's own rule applies
 * and "what you can see" is the honest answer. Two people can read different
 * numbers on one dashboard, and that is correct rather than a bug.
 *
 * Configuration, like goals and saved views: `inTransaction`, `logConfigChange`,
 * no `applyOperations` (D-103).
 */

export interface DashboardRecord {
  id: string;
  name: string;
  containerId: string | null;
  containerName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: string;
  cards: DashboardLayout;
  /** Cards whose stored spec would not parse. Said rather than silently hidden. */
  dropped: number;
}

/** One slice of a chart, resolved to something a renderer can print. */
export interface CardSlice {
  /** The raw group key, so a renderer can colour or link by id. */
  key: string | null;
  label: string;
  count: number;
  /** Of the largest slice, not of the total. */
  fraction: number;
  color: string | null;
}

export type ResolvedCard =
  | { id: string; kind: "stat"; title: string; value: number | null; unit: string | null; failed: string | null }
  | { id: string; kind: "chart"; title: string; slices: CardSlice[]; failed: string | null };

type Connection = Pool | PoolClient;

interface DashboardRow {
  id: string;
  name: string;
  container_id: string | null;
  container_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  created_at: Date;
  layout: unknown;
}

/**
 * The dashboards this viewer may see, in this container or workspace-wide.
 *
 * **Personal dashboards are invisible to everyone else**, which is the saved
 * view rule verbatim (D-057): the two have the same columns — workspace, parent
 * container, owner, name, a json blob — and inventing a second visibility rule
 * for the same shape would be two rules to keep in step for no reason anyone
 * could name.
 */
export async function listDashboards(
  workspaceId: string,
  viewerId: string,
  connection: Connection = pool(),
): Promise<DashboardRecord[]> {
  const result = await connection.query<DashboardRow>(
    `SELECT d.id, d.name, d.container_id, c.name AS container_name,
            d.owner_id, u.name AS owner_name, d.created_at, d.layout
     FROM dashboards d
     LEFT JOIN containers c ON c.id = d.container_id
     LEFT JOIN users u ON u.id = d.owner_id
     WHERE d.workspace_id = $1
       AND (d.owner_id IS NULL OR d.owner_id = $2)
       -- A dashboard on a list nobody has shared with this viewer is not
       -- listed at all. The cards inside it are scoped again when they run,
       -- because a grant can go away between the two (ADR 3).
       AND (
         d.container_id IS NULL
         OR EXISTS (
           SELECT 1 FROM access_index ax
           WHERE ax.list_id = d.container_id AND ax.principal_id = $2
         )
       )
     ORDER BY d.owner_id NULLS FIRST, d.created_at`,
    [workspaceId, viewerId],
  );

  return result.rows.map((row) => {
    const { cards, dropped } = parseLayout(row.layout);
    return {
      id: row.id,
      name: row.name,
      containerId: row.container_id,
      containerName: row.container_name,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      createdAt: row.created_at.toISOString(),
      cards,
      dropped,
    };
  });
}

/**
 * Runs every card on a dashboard, as the viewer.
 *
 * **One switch on `kind`, and it is the only one** (D-104): a stat is
 * `compileAggregate`, a chart is `compileGroupCounts`. The card's kind names
 * the entry point, so this function has no case where it has to inspect a
 * result to find out what it got.
 *
 * A card that throws reports why and the others still render. A dashboard is
 * independent pieces, and a filter that stopped compiling because somebody
 * archived a custom field should cost one card rather than the screen.
 */
export async function resolveCards(
  cards: readonly DashboardCard[],
  context: { workspaceId: string; viewerId: string },
  labels: CardLabels = {},
  connection: Connection = pool(),
): Promise<ResolvedCard[]> {
  if (cards.length === 0) return [];

  const fields = await loadFieldCatalog(context.workspaceId, connection as Pool);

  return Promise.all(
    cards.map(async (card) => {
      try {
        if (card.kind === "stat") {
          const query = compileAggregate({
            workspaceId: context.workspaceId,
            viewerId: context.viewerId,
            scope: card.scope,
            definition: card.definition,
            aggregate: card.aggregate,
            fields,
          });

          const result = await connection.query<{ value: string | number | null }>(
            query.text,
            query.params,
          );
          const raw = result.rows[0]?.value;

          return {
            id: card.id,
            kind: "stat" as const,
            title: card.title,
            value: raw === null || raw === undefined ? null : Number(raw),
            unit: card.unit ?? null,
            failed: null,
          };
        }

        const query = compileGroupCounts({
          workspaceId: context.workspaceId,
          viewerId: context.viewerId,
          scope: card.scope,
          definition: chartDefinition(card),
          fields,
        });

        const result = await connection.query<{ group_key: string | null; count: number }>(
          query.text,
          query.params,
        );

        const counts = result.rows.map((row) => Number(row.count));
        const largest = Math.max(0, ...counts);

        return {
          id: card.id,
          kind: "chart" as const,
          title: card.title,
          slices: result.rows.map((row, index) => ({
            key: row.group_key,
            ...describeKey(card.groupBy, row.group_key, labels),
            count: counts[index]!,
            fraction: largest === 0 ? 0 : counts[index]! / largest,
          })),
          failed: null,
        };
      } catch (error) {
        const why = error instanceof Error ? error.message : "This card could not be drawn";
        return card.kind === "stat"
          ? { id: card.id, kind: "stat" as const, title: card.title, value: null, unit: null, failed: why }
          : { id: card.id, kind: "chart" as const, title: card.title, slices: [], failed: why };
      }
    }),
  );
}

/**
 * The lookups a chart needs to turn group keys into words.
 *
 * Passed in rather than queried here, because the caller is a page that has
 * already loaded most of them — and because the renderer must receive *values*,
 * never ids plus the maps to join them with, which is the boundary the table
 * cells already draw (D-059).
 */
export interface CardLabels {
  statuses?: Map<string, { name: string; color: string }>;
  people?: Map<string, string>;
  containers?: Map<string, string>;
}

const PRIORITY_NAMES: Record<string, string> = {
  "1": "Urgent",
  "2": "High",
  "3": "Normal",
  "4": "Low",
};

const STATUS_GROUPS: Record<string, string> = {
  not_started: "Not started",
  active: "Active",
  done: "Done",
  closed: "Closed",
};

/** A group key, in words — or the honest fallback when it cannot be resolved. */
function describeKey(
  groupBy: string,
  key: string | null,
  labels: CardLabels,
): { label: string; color: string | null } {
  // Null is a real group: tasks with no assignee, no status, no due date. It is
  // usually the most interesting bar on the chart.
  if (key === null) return { label: "None", color: null };

  switch (groupBy) {
    case "status": {
      const status = labels.statuses?.get(key);
      return { label: status?.name ?? "Unknown", color: status?.color ?? null };
    }
    case "statusGroup":
      return { label: STATUS_GROUPS[key] ?? key, color: null };
    case "priority":
      return { label: PRIORITY_NAMES[key] ?? key, color: null };
    case "assignee":
    case "createdBy":
      return { label: labels.people?.get(key) ?? "Someone", color: null };
    case "list":
    case "space":
    case "folder":
      return { label: labels.containers?.get(key) ?? "Elsewhere", color: null };
    default:
      // A uuid on screen is worse than no detail, but a chart with no labels at
      // all is worse still — so the key is shown only when it is not one.
      return { label: looksLikeId(key) ? "—" : key, color: null };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeId(value: string): boolean {
  return UUID_RE.test(value);
}

export interface CreateDashboardInput {
  workspaceId: string;
  name: string;
  containerId?: string | null;
  /** Set means it belongs to one person and nobody else can see it. */
  ownerId?: string | null;
}

export async function createDashboard(
  input: CreateDashboardInput,
  context: ConfigContext,
): Promise<DashboardRecord> {
  const name = requireName(input.name, "dashboard");

  return inTransaction(context, async (client) => {
    const result = await client.query<DashboardRow>(
      `INSERT INTO dashboards (workspace_id, name, container_id, owner_id, layout)
       VALUES ($1, $2, $3, $4, '[]'::jsonb)
       RETURNING id, name, container_id, NULL AS container_name,
                 owner_id, NULL AS owner_name, created_at, layout`,
      [input.workspaceId, name, input.containerId ?? null, input.ownerId ?? null],
    );

    const row = result.rows[0];
    if (!row) throw new ConfigError("Dashboard insert returned nothing");

    await logConfigChange(client, {
      workspaceId: input.workspaceId,
      actorId: context.actorId,
      objectKind: "dashboard",
      objectId: row.id,
      verb: "dashboard.created",
      newValue: { name },
    });

    return {
      id: row.id,
      name: row.name,
      containerId: row.container_id,
      containerName: null,
      ownerId: row.owner_id,
      ownerName: null,
      createdAt: row.created_at.toISOString(),
      cards: [],
      dropped: 0,
    };
  });
}

export async function renameDashboard(
  dashboardId: string,
  name: string,
  context: ConfigContext,
): Promise<void> {
  const trimmed = requireName(name, "dashboard");

  return inTransaction(context, async (client) => {
    const existing = await requireDashboard(client, dashboardId);
    await client.query(`UPDATE dashboards SET name = $2 WHERE id = $1`, [dashboardId, trimmed]);

    await logConfigChange(client, {
      workspaceId: existing.workspace_id,
      actorId: context.actorId,
      objectKind: "dashboard",
      objectId: dashboardId,
      verb: "dashboard.renamed",
      oldValue: { name: existing.name },
      newValue: { name: trimmed },
    });
  });
}

export async function deleteDashboard(
  dashboardId: string,
  context: ConfigContext,
): Promise<void> {
  return inTransaction(context, async (client) => {
    const existing = await requireDashboard(client, dashboardId);
    await client.query(`DELETE FROM dashboards WHERE id = $1`, [dashboardId]);

    await logConfigChange(client, {
      workspaceId: existing.workspace_id,
      actorId: context.actorId,
      objectKind: "dashboard",
      objectId: dashboardId,
      verb: "dashboard.deleted",
      oldValue: { name: existing.name },
    });
  });
}

/**
 * Adds a card, refusing one that cannot be drawn.
 *
 * **Compiled before it is written**, exactly as a saved view and a rollup key
 * result are (D-058, D-101): a card whose definition will not compile is
 * refused when somebody adds it, not discovered when somebody opens the screen.
 * The number it would have produced is thrown away — this is a validation.
 */
export async function addCard(
  dashboardId: string,
  raw: unknown,
  context: ConfigContext,
): Promise<string> {
  const card = parseCard(raw);

  return inTransaction(context, async (client) => {
    const existing = await requireDashboard(client, dashboardId);
    const { cards } = parseLayout(existing.layout);

    if (cards.length >= MAX_CARDS) {
      throw new ConfigError(`A dashboard holds at most ${MAX_CARDS} cards`);
    }

    const fields = await loadFieldCatalog(existing.workspace_id, client as unknown as Pool);

    try {
      if (card.kind === "stat") {
        compileAggregate({
          workspaceId: existing.workspace_id,
          // Any principal compiles the same SQL; only the number differs. This
          // is a syntax check, so the id only has to be well-formed.
          viewerId: "00000000-0000-4000-8000-000000000000",
          scope: card.scope,
          definition: card.definition,
          aggregate: card.aggregate,
          fields,
        });
      } else {
        compileGroupCounts({
          workspaceId: existing.workspace_id,
          viewerId: "00000000-0000-4000-8000-000000000000",
          scope: card.scope,
          definition: chartDefinition(card),
          fields,
        });
      }
    } catch (error) {
      throw new ConfigError(
        `That card cannot be saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await client.query(
      `UPDATE dashboards SET layout = layout || $2::jsonb WHERE id = $1`,
      [dashboardId, JSON.stringify([card])],
    );

    await logConfigChange(client, {
      workspaceId: existing.workspace_id,
      actorId: context.actorId,
      objectKind: "dashboard",
      objectId: dashboardId,
      verb: "dashboard.card_added",
      field: card.id,
      newValue: { title: card.title, kind: card.kind },
    });

    return card.id;
  });
}

/**
 * Removes one card.
 *
 * Rewrites the whole array rather than editing it in place. `layout` is an
 * ordered list and its order is the layout, so a delete is a rewrite whichever
 * way it is expressed — and doing it in JavaScript keeps the one definition of
 * what a card is (`parseCard`) in front of every write.
 */
export async function removeCard(
  dashboardId: string,
  cardId: string,
  context: ConfigContext,
): Promise<void> {
  return inTransaction(context, async (client) => {
    const existing = await requireDashboard(client, dashboardId);
    const { cards } = parseLayout(existing.layout);
    const remaining = cards.filter((card) => card.id !== cardId);

    if (remaining.length === cards.length) throw new ConfigError("That card no longer exists");

    await client.query(`UPDATE dashboards SET layout = $2::jsonb WHERE id = $1`, [
      dashboardId,
      JSON.stringify(remaining),
    ]);

    await logConfigChange(client, {
      workspaceId: existing.workspace_id,
      actorId: context.actorId,
      objectKind: "dashboard",
      objectId: dashboardId,
      verb: "dashboard.card_removed",
      field: cardId,
    });
  });
}

export interface DashboardOwnership {
  workspaceId: string;
  containerId: string | null;
  ownerId: string | null;
}

/** Who a dashboard belongs to and where it lives — for the actions to check. */
export async function dashboardOwnership(
  dashboardId: string,
  connection: Connection = pool(),
): Promise<DashboardOwnership | null> {
  if (!UUID_RE.test(dashboardId)) return null;

  const result = await connection.query<{
    workspace_id: string;
    container_id: string | null;
    owner_id: string | null;
  }>(`SELECT workspace_id, container_id, owner_id FROM dashboards WHERE id = $1`, [dashboardId]);

  const row = result.rows[0];
  return row
    ? { workspaceId: row.workspace_id, containerId: row.container_id, ownerId: row.owner_id }
    : null;
}

interface DashboardMeta {
  workspace_id: string;
  name: string;
  layout: unknown;
}

async function requireDashboard(
  client: PoolClient,
  dashboardId: string,
): Promise<DashboardMeta> {
  const result = await client.query<DashboardMeta>(
    `SELECT workspace_id, name, layout FROM dashboards WHERE id = $1`,
    [dashboardId],
  );
  const row = result.rows[0];
  if (!row) throw new ConfigError("That dashboard no longer exists");
  return row;
}
