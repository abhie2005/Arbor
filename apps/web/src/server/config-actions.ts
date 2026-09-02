"use server";

import type { FieldType, StatusGroup } from "@arbor/core";
import {
  addStatus,
  archiveField,
  attachStatusSet,
  changeFieldType,
  createField,
  createStatusSet,
  createTaskType,
  deleteStatus,
  deleteTaskType,
  moveStatus,
  setDefaultTaskType,
  setFieldScopes,
  updateField,
  updateStatus,
  updateTaskType,
} from "@arbor/db";
import { revalidatePath } from "next/cache";

import { requireUser } from "./auth";
import { requireWorkspace } from "./workspace";

/**
 * Configuration server actions.
 *
 * The same boundary rule as the task actions: these build arguments and call a
 * service, they never write SQL. All the validation lives in @arbor/core and
 * runs inside the service's transaction, so a form that skips a check on the
 * client cannot get a bad set past the server.
 *
 * Each returns `{ ok }` or `{ error }` rather than throwing, because every one
 * of them has a failure a user is expected to hit — "that name is taken", "12
 * tasks still use this status" — and those belong next to the control that
 * caused them, not in an error boundary that replaces the screen.
 */

export type ActionResult = { ok: true } | { ok: false; error: string };

function failed(error: unknown): ActionResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

async function context() {
  const [actor] = await Promise.all([requireUser(), requireWorkspace()]);
  return { actorId: actor.id };
}

function refresh() {
  revalidatePath("/settings", "layout");
  // Configuration changes what the list screen renders — a renamed status is a
  // renamed group header — so the board is stale too.
  revalidatePath("/");
}

// --- statuses ---------------------------------------------------------------

export async function createStatusSetAction(
  name: string,
  templateKey: string,
  containerId: string | null,
): Promise<ActionResult> {
  try {
    const workspace = await requireWorkspace();
    await createStatusSet({ workspaceId: workspace.id, name, templateKey, containerId }, await context());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function attachStatusSetAction(
  setId: string,
  containerId: string | null,
): Promise<ActionResult> {
  try {
    await attachStatusSet(setId, containerId, await context());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function addStatusAction(
  setId: string,
  name: string,
  group: StatusGroup,
  color: string,
): Promise<ActionResult> {
  try {
    await addStatus(setId, { name, group, color }, await context());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function updateStatusAction(
  statusId: string,
  patch: { name?: string; group?: StatusGroup; color?: string },
): Promise<ActionResult> {
  try {
    await updateStatus(statusId, patch, await context());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function moveStatusAction(statusId: string, toIndex: number): Promise<ActionResult> {
  try {
    await moveStatus(statusId, toIndex, await context());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function deleteStatusAction(
  statusId: string,
  replacementId: string,
): Promise<ActionResult> {
  try {
    await deleteStatus(statusId, replacementId, await context());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

// --- custom fields ----------------------------------------------------------

export async function createFieldAction(input: {
  name: string;
  type: FieldType;
  containerId: string | null;
  typeConfig?: unknown;
  scopeTaskTypeIds?: string[];
}): Promise<ActionResult> {
  try {
    const workspace = await requireWorkspace();
    await createField({ workspaceId: workspace.id, ...input }, await context());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function updateFieldAction(
  fieldId: string,
  patch: { name?: string; typeConfig?: unknown },
): Promise<ActionResult> {
  try {
    await updateField(fieldId, patch, await context());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function changeFieldTypeAction(
  fieldId: string,
  nextType: FieldType,
  nextConfig: unknown,
  discardUnconvertible: boolean,
): Promise<ActionResult> {
  try {
    await changeFieldType(fieldId, nextType, nextConfig, { discardUnconvertible }, await context());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function archiveFieldAction(
  fieldId: string,
  archived: boolean,
): Promise<ActionResult> {
  try {
    await archiveField(fieldId, archived, await context());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function setFieldScopesAction(
  fieldId: string,
  taskTypeIds: string[],
): Promise<ActionResult> {
  try {
    await setFieldScopes(fieldId, taskTypeIds, await context());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

// --- task types -------------------------------------------------------------

export async function createTaskTypeAction(name: string, icon: string): Promise<ActionResult> {
  try {
    const workspace = await requireWorkspace();
    await createTaskType({ workspaceId: workspace.id, name, icon: icon || null }, await context());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function updateTaskTypeAction(
  taskTypeId: string,
  patch: { name?: string; icon?: string | null },
): Promise<ActionResult> {
  try {
    await updateTaskType(taskTypeId, patch, await context());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function setDefaultTaskTypeAction(taskTypeId: string): Promise<ActionResult> {
  try {
    await setDefaultTaskType(taskTypeId, await context());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function deleteTaskTypeAction(
  taskTypeId: string,
  replacementId: string | null,
): Promise<ActionResult> {
  try {
    await deleteTaskType(taskTypeId, replacementId, await context());
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}
