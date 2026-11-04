import { loadForm } from "@arbor/db";

import { PublicForm } from "@/components/public-form";

export const dynamic = "force-dynamic";

/**
 * A form, as a stranger sees it (D-142).
 *
 * **The first screen here that renders without a session**, and the only one.
 * Every other page calls `getCurrentUser()` and redirects to `/login` without
 * one; this page never asks who is looking, because the answer is "nobody" and
 * that is the feature.
 *
 * It follows that nothing on this page may come from `requireWorkspace()` —
 * that resolves a workspace from the viewer's memberships (D-137), and there
 * is no viewer. The form carries its own workspace, which is the only thing
 * that could be right: the link names the form, the form names the list.
 *
 * It is deliberately outside `AppShell`. There is no sidebar, no inbox badge,
 * no live stream and no workspace name — a stranger filling in a form should
 * be shown the form and nothing about the organisation behind it.
 */
export default async function FormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await loadForm(id);

  /**
   * One refusal for every reason (invariant 6).
   *
   * Missing, closed, and a definition that no longer parses are three
   * different facts, and a stranger is told the same thing by all of them: a
   * form id is guessable-ish, and "this one exists but is closed" is more than
   * somebody outside the workspace should learn from a URL.
   */
  if (!form || !form.isOpen || !form.definition) {
    return (
      <main className="public-form">
        <div className="public-card">
          <h1>This form is not taking submissions</h1>
          <p className="settings-note">
            The link may be old, or whoever set it up may have closed it.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="public-form">
      <div className="public-card">
        <h1>{form.name}</h1>
        {form.intro ? <p className="public-intro">{form.intro}</p> : null}

        <PublicForm formId={form.id} fields={form.definition.fields} />
      </div>
    </main>
  );
}
