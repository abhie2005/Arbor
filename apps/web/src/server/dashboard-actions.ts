"use server";

import { randomUUID } from "node:crypto";

import { DEFAULT_VIEW_DEFINITION, type FieldRef, type ViewScope } from "@arbor/core";
import {
  addCard,
  createDashboard,
  dashboardOwnership,
  deleteDashboard,
  listAccess,
  removeCard,
  renameDashboard,
  requireWorkspaceRole,
} from "@arbor/db";
import { revalidatePath } from "next/cache";

import { CHART_AXES, type ChartAxis, type StatMetric } from "@/components/card-options";

import { requireUser } from "./auth";
import { requireWorkspace } from "./workspace";

/**
 * Dashboard actions.
 *
 * Configuration, like goals (D-103): no operations, no inverse, ⌘Z does not
 * reach them.
 *
 * **The permission is the container's**, which is the difference from goals and
 * the reason dashboards needed no rule of their own (D-105). A dashboard on a
 * list takes that list's `edit`; a personal one takes being its owner; a
 * workspace-wide one falls back to the workspace role. That is `requireViewAccess`'s
 * shape, applied to a table with the same columns.
 */

async function requireDashboardEditor(dashboardId: string): Promise<void> {
  const actor = await requireUser();
  const dashboard = await dashboardOwnership(dashboardId);

  // Missing and not-yours are one sentence, as everywhere else.
  if (!dashboard) throw new Error("That dashboard no longer exists");

  if (dashboard.ownerId) {
    if (dashboard.ownerId !== actor.id) throw new Error("That dashboard no longer exists");
    return;
  }

  if (!dashboard.containerId) {
    await requireWorkspaceRole(dashboard.workspaceId, actor.id, "admin").catch(() => {
      throw new Error("Only a workspace admin can change a workspace-wide dashboard");
    });
    return;
  }

  const permission = await listAccess(dashboard.containerId, actor.id);
  if (permission !== "edit" && permission !== "manage") {
    throw new Error("You do not have permission to change this dashboard");
  }
}

export async function createWorkspaceDashboard(
  name: string,
  containerId: string | null,
  personal: boolean,
): Promise<{ id: string }> {
  const actor = await requireUser();
  const workspace = await requireWorkspace();

  if (containerId) {
    // Creating a dashboard on a list you cannot edit is how one appears inside
    // a container somebody else owns.
    const permission = await listAccess(containerId, actor.id);
    if (permission !== "edit" && permission !== "manage") {
      throw new Error("You do not have permission to add a dashboard here");
    }
  } else {
    await requireWorkspaceRole(workspace.id, actor.id, "admin");
  }

  const dashboard = await createDashboard(
    {
      workspaceId: workspace.id,
      name,
      containerId,
      ownerId: personal ? actor.id : null,
    },
    { actorId: actor.id },
  );

  revalidatePath("/dashboards");
  return { id: dashboard.id };
}

export async function renameWorkspaceDashboard(
  dashboardId: string,
  name: string,
): Promise<void> {
  const actor = await requireUser();
  await requireDashboardEditor(dashboardId);
  await renameDashboard(dashboardId, name, { actorId: actor.id });
  revalidatePath("/dashboards");
}

export async function removeWorkspaceDashboard(dashboardId: string): Promise<void> {
  const actor = await requireUser();
  await requireDashboardEditor(dashboardId);
  await deleteDashboard(dashboardId, { actorId: actor.id });
  revalidatePath("/dashboards");
}

/**
 * What the add-card form can ask for.
 *
 * A subset of what `layout` can hold, the same way the goal form is a subset of
 * what `source` can hold (D-101): the generality lives in the data, so a filter
 * builder written later needs no migration, and a form covering every case
 * would be the filter bar again.
 */
const STAT_METRICS: Record<
  StatMetric,
  { aggregate: { fn: "count" | "sum"; field?: FieldRef }; showClosed: boolean; done: boolean; overdue: boolean; unit: string }
> = {
  open: { aggregate: { fn: "count" }, showClosed: false, done: false, overdue: false, unit: "open" },
  done: { aggregate: { fn: "count" }, showClosed: true, done: true, overdue: false, unit: "done" },
  overdue: { aggregate: { fn: "count" }, showClosed: false, done: false, overdue: true, unit: "overdue" },
  points: { aggregate: { fn: "sum", field: "points" }, showClosed: false, done: false, overdue: false, unit: "points" },
  estimate: { aggregate: { fn: "sum", field: "timeEstimate" }, showClosed: false, done: false, overdue: false, unit: "estimated" },
};

export async function addDashboardCard(
  dashboardId: string,
  input: {
    title: string;
    kind: string;
    scopeId?: string;
    scopeKind?: "list" | "space";
    metric?: StatMetric;
    axis?: ChartAxis;
  },
): Promise<void> {
  const actor = await requireUser();
  await requireDashboardEditor(dashboardId);

  const scope: ViewScope = input.scopeId
    ? { kind: input.scopeKind ?? "list", id: input.scopeId }
    : { kind: "everything" };

  if (input.kind === "chart") {
    const axis = input.axis ?? "status";
    if (!CHART_AXES.includes(axis)) throw new Error("A chart cannot be grouped by that");

    await addCard(
      dashboardId,
      {
        id: randomUUID(),
        kind: "chart",
        title: input.title,
        scope,
        definition: DEFAULT_VIEW_DEFINITION,
        groupBy: axis,
      },
      { actorId: actor.id },
    );
  } else {
    const metric = input.metric ?? "open";
    const spec = STAT_METRICS[metric];
    if (!spec) throw new Error("That is not something a card can count");

    await addCard(
      dashboardId,
      {
        id: randomUUID(),
        kind: "stat",
        title: input.title,
        scope,
        definition: {
          ...DEFAULT_VIEW_DEFINITION,
          filters: {
            ...DEFAULT_VIEW_DEFINITION.filters,
            // A count of finished work has to see finished work: the default
            // hides closed tasks, so this would otherwise be zero forever with
            // nothing on screen to say why.
            showClosed: spec.showClosed,
            conditions: [
              ...(spec.done ? [{ field: "statusGroup" as const, op: "in" as const, value: ["done", "closed"] }] : []),
              // Overdue means the day is over, which is what `lt` against now
              // says — the date rule is D-067's and lives in the compiler.
              ...(spec.overdue
                ? [
                    { field: "dueAt" as const, op: "lt" as const, value: new Date().toISOString() },
                    { field: "statusGroup" as const, op: "nin" as const, value: ["done", "closed"] },
                  ]
                : []),
            ],
          },
        },
        aggregate: spec.aggregate,
        unit: spec.unit,
      },
      { actorId: actor.id },
    );
  }

  revalidatePath("/dashboards");
}

export async function removeDashboardCard(
  dashboardId: string,
  cardId: string,
): Promise<void> {
  const actor = await requireUser();
  await requireDashboardEditor(dashboardId);
  await removeCard(dashboardId, cardId, { actorId: actor.id });
  revalidatePath("/dashboards");
}
