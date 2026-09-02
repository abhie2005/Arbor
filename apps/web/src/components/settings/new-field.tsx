"use client";

import type { FieldType } from "@arbor/core";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { createFieldAction } from "@/server/config-actions";

import { FieldConfigEditor } from "./field-config-editor";
import type { TypeOption } from "./field-list";

export function NewField({
  containers,
  fieldTypes,
}: {
  containers: { id: string; name: string; kind: string }[];
  fieldTypes: TypeOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("short_text");
  const [containerId, setContainerId] = useState<string>("");
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="settings-add" onClick={() => setOpen(true)}>
        + New field
      </button>
    );
  }

  return (
    <section className="settings-section" data-pending={pending || undefined}>
      <h3 className="settings-heading">New field</h3>

      <div className="settings-form">
        <input
          className="settings-input"
          autoFocus
          placeholder="Field name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          className="settings-select wide"
          value={type}
          onChange={(event) => {
            setType(event.target.value as FieldType);
            // A config belongs to a type. Carrying dropdown options into a
            // number field would be rejected on the server anyway, and the
            // stale inputs in the meantime are just confusing.
            setConfig({});
          }}
        >
          {fieldTypes
            .filter((option) => !option.derived)
            .map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
        </select>
        <select
          className="settings-select wide"
          value={containerId}
          onChange={(event) => setContainerId(event.target.value)}
        >
          <option value="">Whole workspace</option>
          {containers.map((container) => (
            <option key={container.id} value={container.id}>
              {container.name} ({container.kind})
            </option>
          ))}
        </select>
      </div>

      <FieldConfigEditor type={type} config={config} onChange={setConfig} />

      <div className="settings-form">
        <button
          type="button"
          className="settings-primary"
          disabled={!name.trim()}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await createFieldAction({
                name,
                type,
                containerId: containerId || null,
                typeConfig: config,
              });
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setOpen(false);
              setName("");
              setConfig({});
              router.refresh();
            });
          }}
        >
          Create field
        </button>
        <button type="button" className="settings-quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>

      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
