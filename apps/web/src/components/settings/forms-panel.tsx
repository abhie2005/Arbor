"use client";

import { FORMABLE_FIELDS, type FormFieldDeclaration } from "@arbor/core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Timestamp } from "@/components/timestamp";
import { createFormAction, deleteFormAction, setFormOpenAction } from "@/server/form-actions";

/**
 * Forms, from the side that makes them (D-142).
 *
 * The link is the product here, so the list's job is to hand it over: a form
 * nobody can copy the address of is a form nobody can use.
 */

export interface FormContainer {
  id: string;
  name: string;
  depth: number;
}

export interface FormRow {
  id: string;
  name: string;
  intro: string | null;
  /** Null when the stored definition no longer parses — shown, not dropped. */
  fields: FormFieldDeclaration[] | null;
  problem: string | null;
  isOpen: boolean;
  submissionCount: number;
  createdAt: string;
  createdByName: string | null;
}

export function FormsPanel({
  containers,
  selected,
  forms,
}: {
  containers: FormContainer[];
  selected: FormContainer | null;
  forms: FormRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: true; id?: string } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDeleting(null);
      router.refresh();
    });
  }

  return (
    <div className="automations" data-pending={pending || undefined}>
      <div className="sharing-tree">
        {containers.map((container) => (
          <a
            key={container.id}
            className="sharing-node"
            style={{ paddingLeft: `calc(var(--space-3) + ${container.depth} * 14px)` }}
            href={`/settings/forms?container=${container.id}`}
            aria-current={container.id === selected?.id ? "page" : undefined}
          >
            <span className="sharing-kind">▤</span>
            {container.name}
          </a>
        ))}
      </div>

      <div className="sharing-detail">
        {!selected ? (
          <p className="settings-note">
            A form is made on a list you manage. There is no list here you can make one on yet.
          </p>
        ) : (
          <>
            <h3>{selected.name}</h3>

            <div className="automation-list">
              {forms.length === 0 ? (
                <p className="settings-note">No forms on this list yet.</p>
              ) : (
                forms.map((form) => (
                  <div className="automation-row" key={form.id} data-off={!form.isOpen || undefined}>
                    <div className="automation-head">
                      <label className="automation-switch" title="Open">
                        <input
                          type="checkbox"
                          checked={form.isOpen}
                          aria-label={`${form.name} is open`}
                          onChange={() => run(() => setFormOpenAction(form.id, !form.isOpen))}
                        />
                      </label>

                      <span className="automation-name">{form.name}</span>

                      <span className="settings-badge quiet">
                        {form.submissionCount} sent
                      </span>

                      <button
                        type="button"
                        className="settings-icon danger"
                        title="Delete"
                        aria-label={`Delete ${form.name}`}
                        onClick={() => setDeleting(deleting === form.id ? null : form.id)}
                      >
                        ×
                      </button>
                    </div>

                    {/* The address, in full and selectable. A form's whole
                        purpose is a link somebody else opens, so this is the
                        row's most useful line and not a detail behind a menu. */}
                    <p className="automation-sentence">
                      <code className="form-link">{`/f/${form.id}`}</code>
                    </p>

                    <p className="automation-meta">
                      {form.fields ? (
                        <>asks for {form.fields.map((field) => field.label).join(", ")}</>
                      ) : (
                        // Shown rather than hidden, for the reason a broken
                        // rule is (D-129): the public page refuses this form,
                        // and a form nobody can see is a form nobody can fix.
                        <span className="automation-broken">
                          This form can no longer be read: {form.problem}
                        </span>
                      )}{" "}
                      · added <Timestamp at={form.createdAt} /> by{" "}
                      {form.createdByName ?? "somebody since removed"}
                    </p>

                    {deleting === form.id ? (
                      <div className="settings-confirm">
                        <span>
                          Delete this form? The link stops working and the{" "}
                          {form.submissionCount === 1
                            ? "task it made stays"
                            : `${form.submissionCount} tasks it made stay`}
                          .
                        </span>
                        <button
                          type="button"
                          className="settings-danger"
                          onClick={() => run(() => deleteFormAction(form.id))}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          className="settings-quiet"
                          onClick={() => setDeleting(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>

            <NewForm
              key={selected.id}
              containerId={selected.id}
              onSave={(input) => run(() => createFormAction(input))}
            />
          </>
        )}

        {error ? (
          <p className="settings-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function NewForm({
  containerId,
  onSave,
}: {
  containerId: string;
  onSave: (input: { containerId: string; name: string; intro?: string; fields: unknown }) => void;
}) {
  const [name, setName] = useState("");
  const [intro, setIntro] = useState("");
  /**
   * `name` is always asked and always required, so it is not a checkbox.
   * Offering to turn it off would offer to make a form that produces tasks
   * nobody can find, and the parser refuses that anyway.
   */
  const [asked, setAsked] = useState<Record<string, boolean>>({});
  const [required, setRequired] = useState<Record<string, boolean>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});

  const optional = FORMABLE_FIELDS.filter((field) => field.field !== "name");

  function fields() {
    return [
      { field: "name", label: labels.name ?? "", required: true },
      ...optional
        .filter((field) => asked[field.field])
        .map((field) => ({
          field: field.field,
          label: labels[field.field] ?? "",
          required: required[field.field] === true,
        })),
    ];
  }

  return (
    <section className="settings-section automation-new">
      <h3 className="settings-heading">New form</h3>

      <div className="settings-form">
        <input
          className="settings-input"
          placeholder="What this form is for"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="settings-form">
        <input
          className="settings-input"
          placeholder="What it says above the fields (optional)"
          value={intro}
          onChange={(event) => setIntro(event.target.value)}
        />
      </div>

      <div className="form-fields">
        <label className="form-field-row" data-fixed="true">
          <input type="checkbox" checked disabled aria-label="Name is always asked" />
          <span className="form-field-name">Name</span>
          <input
            className="settings-input"
            placeholder="What do you need?"
            aria-label="Label for Name"
            value={labels.name ?? ""}
            onChange={(event) => setLabels((l) => ({ ...l, name: event.target.value }))}
          />
          <span className="settings-badge quiet">always asked</span>
        </label>

        {optional.map((field) => (
          <label className="form-field-row" key={field.field}>
            <input
              type="checkbox"
              checked={asked[field.field] === true}
              aria-label={`Ask for ${field.label}`}
              onChange={(event) =>
                setAsked((a) => ({ ...a, [field.field]: event.target.checked }))
              }
            />
            <span className="form-field-name">{field.label}</span>
            <input
              className="settings-input"
              placeholder={field.label}
              aria-label={`Label for ${field.label}`}
              disabled={asked[field.field] !== true}
              value={labels[field.field] ?? ""}
              onChange={(event) =>
                setLabels((l) => ({ ...l, [field.field]: event.target.value }))
              }
            />
            <label className="form-field-required">
              <input
                type="checkbox"
                disabled={asked[field.field] !== true}
                checked={required[field.field] === true}
                aria-label={`${field.label} is required`}
                onChange={(event) =>
                  setRequired((r) => ({ ...r, [field.field]: event.target.checked }))
                }
              />
              required
            </label>
          </label>
        ))}
      </div>

      <div className="settings-form">
        <button
          type="button"
          className="settings-primary"
          disabled={!name.trim()}
          onClick={() => {
            onSave({
              containerId,
              name,
              intro: intro.trim() || undefined,
              fields: fields(),
            });
            setName("");
            setIntro("");
            setAsked({});
            setRequired({});
            setLabels({});
          }}
        >
          Make the form
        </button>
      </div>
    </section>
  );
}
