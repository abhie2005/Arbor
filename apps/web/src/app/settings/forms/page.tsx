import { ancestorsOf } from "@arbor/core";
import { loadContainerTree, loadFormsForContainers, reachableContainers } from "@arbor/db";

import { FormsPanel, type FormContainer, type FormRow } from "@/components/settings/forms-panel";
import { requireUser } from "@/server/auth";
import { requireWorkspace } from "@/server/workspace";

export const dynamic = "force-dynamic";

/**
 * Where a form is made (D-142).
 *
 * The same shape as the automations and tokens screens, for the same reason:
 * a form is scoped to one container and writing one takes `manage` on it, so
 * the tree is scoped by `reachableContainers(… "manage")` and a member gets an
 * explanation rather than a form that would refuse them.
 *
 * **It lists the forms whose container the viewer manages**, not the
 * workspace's (D-123): somebody who cannot manage the list cannot close the
 * form and has no business being told it exists.
 */
export default async function FormsPage({
  searchParams,
}: {
  searchParams: Promise<{ container?: string }>;
}) {
  const [{ container }, workspace, viewer] = await Promise.all([
    searchParams,
    requireWorkspace(),
    requireUser(),
  ]);

  const tree = await loadContainerTree(workspace.id);
  const manageable = await reachableContainers(workspace.id, viewer.id, "manage");
  const nodes = [...tree.values()];

  const ordered: typeof nodes = [];
  const walk = (parentId: string | null) => {
    for (const node of nodes
      .filter((candidate) => candidate.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      ordered.push(node);
      walk(node.id);
    }
  };
  walk(null);

  /**
   * Lists only.
   *
   * A submission creates a task, and a task lives in a list — so a form on a
   * space would have to invent which of its lists it meant. The automations
   * screen offers every container because a rule *acts on* tasks wherever they
   * are; a form *makes* one, which is a narrower question.
   */
  const containers: FormContainer[] = ordered
    .filter((node) => node.kind === "list" && manageable.has(node.id))
    .map((node) => ({
      id: node.id,
      name: node.name,
      depth: ancestorsOf(node.id, tree).filter(
        (ancestor) => ancestor.id !== node.id && manageable.has(ancestor.id),
      ).length,
    }));

  const selected =
    containers.find((candidate) => candidate.id === container) ?? containers[0] ?? null;

  const forms: FormRow[] = selected
    ? (await loadFormsForContainers([selected.id])).map((form) => ({
        id: form.id,
        name: form.name,
        intro: form.intro,
        fields: form.definition?.fields ?? null,
        problem: form.problem,
        isOpen: form.isOpen,
        submissionCount: form.submissionCount,
        // ISO across the boundary, rendered by `Timestamp` (D-097, D-121).
        createdAt: form.createdAt.toISOString(),
        createdByName: form.createdByName,
      }))
    : [];

  return (
    <>
      <header className="header">
        <div className="crumb">
          Settings<span>&#8250;</span>
          <strong>Forms</strong>
        </div>
      </header>

      <div className="settings-body">
        <p className="settings-note">
          A form is a link anybody can open without an account. What they send becomes a task in
          the list the form was made on, written by the form itself rather than by you — and a
          submission can fill the fields the form asks for and nothing else.
        </p>

        <FormsPanel containers={containers} selected={selected} forms={forms} />
      </div>
    </>
  );
}
