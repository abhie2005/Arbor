"use server";

import {
  createForm,
  deleteForm,
  loadForm,
  requireContainerAccess,
  setFormOpen,
  submitForm,
} from "@arbor/db";
import { revalidatePath } from "next/cache";

import { requireUser } from "./auth";
import { requireWorkspace } from "./workspace";

/**
 * Forms (D-142).
 *
 * **Two audiences in one file, and that is the point of reading it together.**
 * Everything above `submitFormAction` takes `manage` on the form's container,
 * like an automation (D-129) or a token (D-135) — a form is the same shape of
 * thing: scoped to one container, acting only inside it.
 *
 * `submitFormAction` takes nothing, and is the only action in this codebase
 * that does not authenticate. Invariant 4 says every server action authorizes
 * as well as authenticates; this one is the documented exception, and what
 * stands in for authorization is narrower than a permission check:
 *
 * - the **form** says which list is written and what fields may be filled, and
 *   a manager wrote the form;
 * - the write happens as the form's own principal, whose grant is `edit` on
 *   that one container (D-142), so it cannot reach past the door;
 * - `parseSubmission` refuses anything the form did not ask for.
 *
 * None of that is a permission *the caller* holds, which is the honest way to
 * describe a public form: the caller holds nothing, and the door is as narrow
 * as the person who opened it made it.
 */

export type FormResult = { ok: true; id?: string } | { ok: false; error: string };

function failed(error: unknown): FormResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function refresh() {
  revalidatePath("/settings/forms");
}

/** The container is read off the form, never taken from the request. */
async function managerOfForm(formId: string) {
  const form = await loadForm(formId);
  if (!form) throw new Error("That form no longer exists");
  const actor = await requireUser();
  await requireContainerAccess(form.containerId, actor.id, "manage");
  return { form, actor };
}

export async function createFormAction(input: {
  containerId: string;
  name: string;
  intro?: string;
  fields: unknown;
}): Promise<FormResult> {
  try {
    const [workspace, actor] = await Promise.all([requireWorkspace(), requireUser()]);
    await requireContainerAccess(input.containerId, actor.id, "manage");

    const id = await createForm(
      {
        workspaceId: workspace.id,
        containerId: input.containerId,
        name: input.name,
        intro: input.intro,
        fields: input.fields,
      },
      { actorId: actor.id },
    );

    refresh();
    return { ok: true, id };
  } catch (error) {
    return failed(error);
  }
}

export async function setFormOpenAction(formId: string, isOpen: boolean): Promise<FormResult> {
  try {
    const { actor } = await managerOfForm(formId);
    await setFormOpen(formId, isOpen, { actorId: actor.id });
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function deleteFormAction(formId: string): Promise<FormResult> {
  try {
    const { actor } = await managerOfForm(formId);
    await deleteForm(formId, { actorId: actor.id });
    refresh();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/**
 * The public one. No session, no actor, no `requireUser`.
 *
 * It returns the refusal as a message rather than throwing, like every other
 * action here — but for a different reason: a stranger gets the sentence the
 * form itself produced ("Needed by must be a date") and never anything about
 * the workspace behind it. `submitForm` is where that line is drawn, and a
 * broken form answers in the same words a closed one does.
 */
export async function submitFormAction(
  formId: string,
  answers: Record<string, unknown>,
): Promise<FormResult> {
  try {
    const { taskId } = await submitForm(formId, answers);
    // The list this landed in, for anybody with it open. Not the form's own
    // page: a stranger's view of it does not change.
    revalidatePath("/");
    return { ok: true, id: taskId };
  } catch (error) {
    return failed(error);
  }
}
