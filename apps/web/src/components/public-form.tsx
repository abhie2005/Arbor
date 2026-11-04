"use client";

import { type FormFieldDeclaration } from "@arbor/core";
import { useState, useTransition } from "react";

import { submitFormAction } from "@/server/form-actions";

/**
 * The control a field needs, which is a much shorter list than a task's.
 *
 * A form asks for five things at most (`FORMABLE_FIELDS`), so this is a
 * `switch` over those rather than the field-type machinery the task page uses:
 * a stranger's form has no custom fields, no people pickers and nothing that
 * needs the workspace's own vocabulary loaded to render.
 */
function Control({
  field,
  value,
  onChange,
}: {
  field: FormFieldDeclaration;
  value: string;
  onChange: (next: string) => void;
}) {
  const id = `field-${field.field}`;
  const common = {
    id,
    className: "settings-input",
    value,
    required: field.required,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };

  switch (field.field) {
    case "priority":
      return (
        <select {...common} className="settings-select">
          <option value="">—</option>
          <option value="1">Urgent</option>
          <option value="2">High</option>
          <option value="3">Normal</option>
          <option value="4">Low</option>
        </select>
      );

    case "dueAt":
    case "startAt":
      return <input {...common} type="date" />;

    case "points":
      return <input {...common} type="number" min="0" step="0.5" />;

    default:
      // The name, which is the one field every form has. A textarea because
      // what somebody types into a form is usually a sentence, and a single
      // line makes them write less than they meant to.
      return <textarea {...common} rows={3} />;
  }
}

export function PublicForm({
  formId,
  fields,
}: {
  formId: string;
  fields: FormFieldDeclaration[];
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  if (sent) {
    return (
      <div className="public-done">
        <p>Thank you — that has been sent.</p>
        {/* No link onwards. A stranger has nowhere to go in this workspace,
            and offering them one would be an invitation to somewhere they
            cannot read. */}
        <button
          type="button"
          className="settings-quiet"
          onClick={() => {
            setAnswers({});
            setSent(false);
          }}
        >
          Send another
        </button>
      </div>
    );
  }

  return (
    <form
      className="public-fields"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);

        // Sent as the keys the form declared, so the server's whitelist and
        // this object are describing the same thing. Blank optional answers
        // are dropped here as well as there — `parseSubmission` treats blank
        // as absent, and sending them anyway would make the two disagree
        // about what "unanswered" looks like.
        const body: Record<string, unknown> = {};
        for (const field of fields) {
          const given = answers[field.field];
          if (given !== undefined && given !== "") body[field.field] = given;
        }

        startTransition(async () => {
          const result = await submitFormAction(formId, body);
          if (result.ok) setSent(true);
          else setError(result.error);
        });
      }}
    >
      {fields.map((field) => (
        <label key={field.field} className="public-field">
          <span className="public-label">
            {field.label}
            {field.required ? <span aria-hidden="true"> *</span> : null}
          </span>
          <Control
            field={field}
            value={answers[field.field] ?? ""}
            onChange={(next) => setAnswers((current) => ({ ...current, [field.field]: next }))}
          />
        </label>
      ))}

      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="submit" className="settings-primary" disabled={pending}>
        {pending ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
