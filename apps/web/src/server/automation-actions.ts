"use server";

import {
  createAutomation,
  deleteAutomation,
  loadAutomation,
  requireContainerAccess,
  setAutomationEnabled,
} from "@arbor/db";
import { revalidatePath } from "next/cache";

import { requireUser } from "./auth";
import { requireWorkspace } from "./workspace";

/**
 * Automation server actions.
 *
 * Same boundary rule as every other action file: build arguments, call a
 * service, never write SQL. The validation is the service's — `createAutomation`
 * parses the rule before it writes it — so a form that skipped a check cannot
 * get a rule past the server, and the error it gets back is the one the parser
 * actually raised rather than a paraphrase.
 *
 * **These take `manage` on the rule's container, not an admin role** — the
 * question D-126 left open for the screen. A rule is scoped to one container
 * and acts on tasks inside it, which makes it the shape of sharing (D-109)
 * rather than the shape of a status set: statuses, fields and task types are
 * workspace-wide configuration, so administering them is a workspace role
 * (D-081), while an automation is a thing you do to a container you hold.
 *
 * It is not looser than an admin check. `manage` comes from a grant or from
 * owning an open container, and a member holds `edit` at most — so a member
 * cannot arm a robot. It is narrower in the other direction too: an admin has
 * no `manage` on a private space they were never granted, and so cannot write
 * a rule that acts on tasks they cannot see.
 */

export type AutomationResult = { ok: true } | { ok: false; error: string };

function failed(error: unknown): AutomationResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** Writing a rule takes `manage` on the container it is scoped to. */
async function managerOf(containerId: string) {
  const actor = await requireUser();
  await requireContainerAccess(containerId, actor.id, "manage");
  return actor;
}

/**
 * The container is read from the rule before the check is made.
 *
 * An id arriving from a form says which rule, not which container — and
 * checking the container the *form* claims would let a request name a
 * container it manages and a rule it does not. A refusal says the rule is
 * gone when it cannot be reached, in the same words as genuinely missing
 * (invariant 6).
 */
async function managerOfRule(automationId: string) {
  const rule = await loadAutomation(automationId);
  if (!rule) throw new Error("That automation no longer exists");
  await managerOf(rule.containerId);
  return rule;
}

function refresh() {
  revalidatePath("/settings/automations");
}

export async function createAutomationAction(input: {
  containerId: string;
  name: string;
  trigger: unknown;
  conditions?: unknown;
  actions: unknown;
  appliesTo?: string;
  delaySeconds?: number;
}): Promise<AutomationResult> {
  try {
    const [actor, workspace] = await Promise.all([
      managerOf(input.containerId),
      requireWorkspace(),
    ]);

    await createAutomation(
      {
        workspaceId: workspace.id,
        containerId: input.containerId,
        name: input.name,
        trigger: input.trigger,
        conditions: input.conditions,
        actions: input.actions,
        appliesTo: input.appliesTo,
        delaySeconds: input.delaySeconds,
      },
      { actorId: actor.id },
    );

    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function setAutomationEnabledAction(
  automationId: string,
  isEnabled: boolean,
): Promise<AutomationResult> {
  try {
    const actor = await requireUser();
    await managerOfRule(automationId);
    await setAutomationEnabled(automationId, isEnabled, { actorId: actor.id });
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function deleteAutomationAction(automationId: string): Promise<AutomationResult> {
  try {
    const actor = await requireUser();
    await managerOfRule(automationId);
    await deleteAutomation(automationId, { actorId: actor.id });
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}
