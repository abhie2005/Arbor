"use server";

import { DEFAULT_VIEW_DEFINITION, type ViewDefinition, type ViewScope } from "@arbor/core";
import {
  addKeyResult,
  createGoal,
  deleteGoal,
  deleteKeyResult,
  goalOwnership,
  keyResultOwnership,
  requireWorkspaceRole,
  updateGoal,
  updateKeyResult,
} from "@arbor/db";
import { revalidatePath } from "next/cache";

import { requireUser } from "./auth";
import { requireWorkspace } from "./workspace";

/**
 * Goal actions.
 *
 * **These return nothing to undo, and that is the point.** Every other action
 * file builds `Operation` values and hands back an inverse (D-036). A goal is
 * configuration, not task data — it has no task id, and `taskId` is what
 * authorization is scoped to and what `undo` maps a batch onto (D-080). So
 * these go through the configuration services, which write their own activity
 * rows (D-016), and ⌘Z does not reach them, the same as it does not reach a
 * status set or a custom field.
 *
 * **Owner or admin** (D-103). Creating a goal takes membership; changing one
 * takes being the person it belongs to, or being an admin. That is blunter than
 * a container permission would be and blunt in the safe direction, the same
 * trade D-081 made — and it is less arbitrary here than it is there, because a
 * goal genuinely has an owner and a space genuinely does not.
 */

async function requireGoalEditor(goalId: string): Promise<{ workspaceId: string }> {
  const actor = await requireUser();
  const goal = await goalOwnership(goalId);

  // Missing and not-yours are the same sentence, as everywhere else: told
  // apart, they are an oracle for which goals exist.
  if (!goal) throw new Error("That goal no longer exists");

  if (goal.ownerId !== actor.id) {
    await requireWorkspaceRole(goal.workspaceId, actor.id, "admin").catch(() => {
      throw new Error("Only the goal's owner or a workspace admin can change it");
    });
  }

  return { workspaceId: goal.workspaceId };
}

export async function createWorkspaceGoal(
  name: string,
  dueAt: string | null,
): Promise<{ id: string }> {
  const actor = await requireUser();
  const workspace = await requireWorkspace();

  // A guest can see a workspace; setting its targets is a member's job.
  await requireWorkspaceRole(workspace.id, actor.id, "member");

  const goal = await createGoal(
    {
      workspaceId: workspace.id,
      name,
      // Dates on a goal are calendar days: "by the end of March" is a day, not
      // an instant, and reading it in UTC is the rule everywhere (D-067).
      dueAt: dueAt ? new Date(`${dueAt}T00:00:00.000Z`) : null,
    },
    { actorId: actor.id },
  );

  revalidatePath("/goals");
  return { id: goal.id };
}

export async function renameGoal(goalId: string, name: string): Promise<void> {
  const actor = await requireUser();
  await requireGoalEditor(goalId);
  await updateGoal(goalId, { name }, { actorId: actor.id });
  revalidatePath("/goals");
}

export async function setGoalOwner(goalId: string, ownerId: string): Promise<void> {
  const actor = await requireUser();
  await requireGoalEditor(goalId);

  // Never null from here. An ownerless goal cannot be measured at all (D-102),
  // and a control that silently turns off every rollup is not a control.
  if (!ownerId) throw new Error("A goal needs an owner to measure it as");

  await updateGoal(goalId, { ownerId }, { actorId: actor.id });
  revalidatePath("/goals");
}

export async function setGoalDue(goalId: string, dueAt: string | null): Promise<void> {
  const actor = await requireUser();
  await requireGoalEditor(goalId);
  await updateGoal(
    goalId,
    { dueAt: dueAt ? new Date(`${dueAt}T00:00:00.000Z`) : null },
    { actorId: actor.id },
  );
  revalidatePath("/goals");
}

/**
 * Marks a goal done, or not.
 *
 * Explicit rather than derived from progress: key results are a proxy, and
 * somebody has to say the thing they were a proxy for actually happened. A goal
 * can also be finished while a key result is short, which a threshold could
 * never express.
 */
export async function setGoalComplete(goalId: string, complete: boolean): Promise<void> {
  const actor = await requireUser();
  await requireGoalEditor(goalId);
  await updateGoal(goalId, { completed: complete }, { actorId: actor.id });
  revalidatePath("/goals");
}

export async function removeGoal(goalId: string): Promise<void> {
  const actor = await requireUser();
  await requireGoalEditor(goalId);
  await deleteGoal(goalId, { actorId: actor.id });
  revalidatePath("/goals");
}

/**
 * What the new-key-result form can ask for.
 *
 * **A subset of what `source` can express, deliberately.** The column holds a
 * whole view definition (D-101), so a rollup can be any query the compiler can
 * say; this form offers the four people actually ask for. The generality is in
 * the data rather than in the form, which is the right way round — a definition
 * written by a future filter builder needs no migration, and a form covering
 * every case would be the filter bar again.
 */
export type RollupMetric = "tasks" | "completed" | "points" | "estimate";

const METRICS: Record<RollupMetric, { aggregate: { fn: "count" | "sum"; field?: "points" | "timeEstimate" }; done: boolean }> = {
  tasks: { aggregate: { fn: "count" }, done: false },
  completed: { aggregate: { fn: "count" }, done: true },
  points: { aggregate: { fn: "sum", field: "points" }, done: false },
  estimate: { aggregate: { fn: "sum", field: "timeEstimate" }, done: false },
};

/** Turns the form's four choices into a definition the compiler validates. */
function rollupSource(scope: ViewScope, metric: RollupMetric): Record<string, unknown> {
  const spec = METRICS[metric];
  if (!spec) throw new Error("That is not something a goal can count");

  const definition: ViewDefinition = {
    ...DEFAULT_VIEW_DEFINITION,
    filters: {
      ...DEFAULT_VIEW_DEFINITION.filters,
      // "Completed" has to see closed tasks: the default hides them, and a
      // count of finished work that excluded the finished work would be zero
      // forever with nothing to indicate why.
      showClosed: spec.done,
      conditions: spec.done
        ? [{ field: "statusGroup", op: "in", value: ["done", "closed"] }]
        : [],
    },
  };

  return { scope, definition, aggregate: spec.aggregate };
}

export async function addGoalKeyResult(
  goalId: string,
  input: {
    name: string;
    kind: string;
    start?: string;
    target?: string;
    current?: string;
    currency?: string;
    scopeId?: string;
    scopeKind?: "list" | "space";
    metric?: RollupMetric;
  },
): Promise<void> {
  const actor = await requireUser();
  await requireGoalEditor(goalId);

  const source =
    input.kind === "rollup"
      ? rollupSource(
          input.scopeId
            ? { kind: input.scopeKind ?? "list", id: input.scopeId }
            : { kind: "everything" },
          input.metric ?? "tasks",
        )
      : input.kind === "currency"
        ? { currency: input.currency ?? "USD" }
        : {};

  await addKeyResult(
    goalId,
    {
      name: input.name,
      kind: input.kind,
      start: input.start,
      target: input.target,
      current: input.current,
      source,
    },
    { actorId: actor.id },
  );

  revalidatePath("/goals");
}

export async function setKeyResultValue(keyResultId: string, current: string): Promise<void> {
  const actor = await requireUser();
  const owned = await keyResultOwnership(keyResultId);
  if (!owned) throw new Error("That key result no longer exists");
  await requireGoalEditor(owned.goalId);

  await updateKeyResult(keyResultId, { current }, { actorId: actor.id });
  revalidatePath("/goals");
}

export async function removeKeyResult(keyResultId: string): Promise<void> {
  const actor = await requireUser();
  const owned = await keyResultOwnership(keyResultId);
  if (!owned) throw new Error("That key result no longer exists");
  await requireGoalEditor(owned.goalId);

  await deleteKeyResult(keyResultId, { actorId: actor.id });
  revalidatePath("/goals");
}
