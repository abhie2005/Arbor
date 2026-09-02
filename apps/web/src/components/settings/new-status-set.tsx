"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { createStatusSetAction } from "@/server/config-actions";

/**
 * Creating a set from a template.
 *
 * There is no "blank set" option on purpose: an empty status editor is a bad
 * place to learn what the four groups mean, and every template is fully
 * editable the moment it lands.
 */
export function NewStatusSet({
  templates,
}: {
  templates: { key: string; name: string; description: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [templateKey, setTemplateKey] = useState(templates[0]?.key ?? "simple");
  const [error, setError] = useState<string | null>(null);

  const template = templates.find((t) => t.key === templateKey);

  if (!open) {
    return (
      <button type="button" className="settings-add" onClick={() => setOpen(true)}>
        + New status set
      </button>
    );
  }

  return (
    <section className="settings-section" data-pending={pending || undefined}>
      <h3 className="settings-heading">New status set</h3>

      <div className="settings-form">
        <input
          className="settings-input"
          autoFocus
          placeholder="Set name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          className="settings-select wide"
          value={templateKey}
          onChange={(event) => setTemplateKey(event.target.value)}
        >
          {templates.map((option) => (
            <option key={option.key} value={option.key}>
              {option.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="settings-primary"
          disabled={!name.trim()}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await createStatusSetAction(name, templateKey, null);
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setOpen(false);
              setName("");
              router.refresh();
            });
          }}
        >
          Create
        </button>
        <button type="button" className="settings-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>

      {template ? <p className="settings-note">{template.description}</p> : null}
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
