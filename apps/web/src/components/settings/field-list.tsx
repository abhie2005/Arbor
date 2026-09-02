"use client";

import type { FieldType } from "@arbor/core";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  archiveFieldAction,
  changeFieldTypeAction,
  setFieldScopesAction,
  updateFieldAction,
} from "@/server/config-actions";

import { FieldConfigEditor } from "./field-config-editor";

export interface FieldRow {
  id: string;
  name: string;
  type: FieldType;
  typeConfig: Record<string, unknown>;
  containerId: string | null;
  containerName: string;
  scopeTaskTypeIds: string[];
  archived: boolean;
  valueCount: number;
}

export interface TypeOption {
  value: FieldType;
  label: string;
  derived: boolean;
}

export function FieldList({
  fields,
  taskTypes,
  fieldTypes,
}: {
  fields: FieldRow[];
  taskTypes: { id: string; name: string }[];
  fieldTypes: TypeOption[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (fields.length === 0) {
    return <p className="settings-note">No custom fields yet.</p>;
  }

  return (
    <section className="settings-section">
      <div className="field-list">
        {fields.map((field) => (
          <FieldPanel
            key={field.id}
            field={field}
            taskTypes={taskTypes}
            fieldTypes={fieldTypes}
            open={expanded === field.id}
            onToggle={() => setExpanded(expanded === field.id ? null : field.id)}
          />
        ))}
      </div>
    </section>
  );
}

function FieldPanel({
  field,
  taskTypes,
  fieldTypes,
  open,
  onToggle,
}: {
  field: FieldRow;
  taskTypes: { id: string; name: string }[];
  fieldTypes: TypeOption[];
  open: boolean;
  onToggle: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(field.name);
  const [config, setConfig] = useState(field.typeConfig);
  const [nextType, setNextType] = useState<FieldType>(field.type);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const typeLabel = fieldTypes.find((t) => t.value === field.type)?.label ?? field.type;

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfirmDiscard(false);
      router.refresh();
    });
  }

  return (
    <div className="field-panel" data-pending={pending || undefined} data-archived={field.archived || undefined}>
      <button type="button" className="field-summary" onClick={onToggle}>
        <span className="field-caret">{open ? "▾" : "▸"}</span>
        <span className="field-name">{field.name}</span>
        <span className="settings-badge">{typeLabel}</span>
        <span className="settings-badge quiet">{field.containerName}</span>
        {field.scopeTaskTypeIds.length > 0 ? (
          <span className="settings-badge quiet">
            {field.scopeTaskTypeIds.length} type{field.scopeTaskTypeIds.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {field.archived ? <span className="settings-badge warn">Archived</span> : null}
        <span className="settings-count">{field.valueCount || "—"}</span>
      </button>

      {open ? (
        <div className="field-body">
          <div className="settings-form">
            <input
              className="settings-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => {
                if (name.trim() && name !== field.name) run(() => updateFieldAction(field.id, { name }));
                else setName(field.name);
              }}
            />
            <button
              type="button"
              className="settings-quiet"
              onClick={() => run(() => archiveFieldAction(field.id, !field.archived))}
            >
              {field.archived ? "Restore" : "Archive"}
            </button>
          </div>

          <FieldConfigEditor type={field.type} config={config} onChange={setConfig} />

          <div className="settings-form">
            <button
              type="button"
              className="settings-primary"
              onClick={() => run(() => updateFieldAction(field.id, { typeConfig: config }))}
            >
              Save configuration
            </button>
          </div>

          <h4 className="settings-subheading">Task types</h4>
          <p className="settings-note">
            With none selected the field applies to every type — absence of a restriction is not
            absence of applicability.
          </p>
          <div className="settings-checks">
            {taskTypes.map((taskType) => {
              const checked = field.scopeTaskTypeIds.includes(taskType.id);
              return (
                <label className="settings-check" key={taskType.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      run(() =>
                        setFieldScopesAction(
                          field.id,
                          checked
                            ? field.scopeTaskTypeIds.filter((id) => id !== taskType.id)
                            : [...field.scopeTaskTypeIds, taskType.id],
                        ),
                      )
                    }
                  />
                  <span>{taskType.name}</span>
                </label>
              );
            })}
          </div>

          <h4 className="settings-subheading">Change type</h4>
          <p className="settings-note">
            Values live in the column their type chose, so this moves {field.valueCount} stored
            value{field.valueCount === 1 ? "" : "s"}. Anything that will not convert is reported
            before it is discarded.
          </p>
          <div className="settings-form">
            <select
              className="settings-select wide"
              value={nextType}
              onChange={(event) => setNextType(event.target.value as FieldType)}
            >
              {fieldTypes
                .filter((option) => !option.derived)
                .map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="settings-danger"
              disabled={nextType === field.type}
              onClick={() =>
                run(() => changeFieldTypeAction(field.id, nextType, {}, confirmDiscard))
              }
            >
              {confirmDiscard ? "Convert and discard" : "Convert"}
            </button>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={confirmDiscard}
                onChange={(event) => setConfirmDiscard(event.target.checked)}
              />
              <span>Discard values that will not convert</span>
            </label>
          </div>

          {error ? (
            <p className="settings-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
