"use client";

import type { FieldType } from "@arbor/core";

/**
 * The per-type config editor.
 *
 * Driven by the field's type rather than by a generic JSON textarea, because
 * `typeConfig` is the part of a field that users get wrong: a dropdown with no
 * options, a currency code that is not a currency, a progress range that cannot
 * contain a value. Typed inputs make most of those unreachable, and
 * `parseFieldConfig` on the server catches the rest.
 */
export function FieldConfigEditor({
  type,
  config,
  onChange,
}: {
  type: FieldType;
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const set = (patch: Record<string, unknown>) => onChange({ ...config, ...patch });

  switch (type) {
    case "drop_down":
    case "labels":
      return <OptionsEditor config={config} onChange={onChange} />;

    case "currency":
      return (
        <div className="settings-config">
          <label>
            <span>Code</span>
            <input
              className="settings-input short"
              value={String(config.code ?? "USD")}
              onChange={(event) => set({ code: event.target.value.toUpperCase() })}
              maxLength={3}
            />
          </label>
          <label>
            <span>Decimals</span>
            <input
              className="settings-input short"
              type="number"
              min={0}
              max={4}
              value={Number(config.precision ?? 2)}
              onChange={(event) => set({ precision: Number(event.target.value) })}
            />
          </label>
        </div>
      );

    case "number":
      return (
        <div className="settings-config">
          <label>
            <span>Decimals</span>
            <input
              className="settings-input short"
              type="number"
              min={0}
              max={8}
              value={Number(config.precision ?? 0)}
              onChange={(event) => set({ precision: Number(event.target.value) })}
            />
          </label>
        </div>
      );

    case "rating":
      return (
        <div className="settings-config">
          <label>
            <span>Out of</span>
            <input
              className="settings-input short"
              type="number"
              min={1}
              max={10}
              value={Number(config.max ?? 5)}
              onChange={(event) => set({ max: Number(event.target.value) })}
            />
          </label>
        </div>
      );

    case "date":
      return (
        <div className="settings-config">
          <label className="settings-check">
            <input
              type="checkbox"
              checked={config.includeTime === true}
              onChange={(event) => set({ includeTime: event.target.checked })}
            />
            <span>Include a time of day</span>
          </label>
        </div>
      );

    case "manual_progress":
      return (
        <div className="settings-config">
          <label>
            <span>From</span>
            <input
              className="settings-input short"
              type="number"
              value={Number(config.start ?? 0)}
              onChange={(event) => set({ start: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>To</span>
            <input
              className="settings-input short"
              type="number"
              value={Number(config.end ?? 100)}
              onChange={(event) => set({ end: Number(event.target.value) })}
            />
          </label>
        </div>
      );

    case "short_text":
    case "text":
      return (
        <div className="settings-config">
          <label>
            <span>Max length</span>
            <input
              className="settings-input short"
              type="number"
              min={1}
              placeholder="none"
              value={config.maxLength === undefined ? "" : Number(config.maxLength)}
              onChange={(event) =>
                set({ maxLength: event.target.value ? Number(event.target.value) : undefined })
              }
            />
          </label>
        </div>
      );

    case "users":
    case "tasks":
    case "relationship":
      return (
        <div className="settings-config">
          <label className="settings-check">
            <input
              type="checkbox"
              checked={config.multiple !== false}
              onChange={(event) => set({ multiple: event.target.checked })}
            />
            <span>Allow several values</span>
          </label>
        </div>
      );

    case "formula":
      return (
        <div className="settings-config">
          <label className="grow">
            <span>Expression</span>
            <input
              className="settings-input"
              placeholder="due_at - start_at"
              value={String(config.expression ?? "")}
              onChange={(event) => set({ expression: event.target.value })}
            />
          </label>
          <label>
            <span>Returns</span>
            <select
              className="settings-select"
              value={String(config.resultType ?? "number")}
              onChange={(event) => set({ resultType: event.target.value })}
            >
              <option value="number">Number</option>
              <option value="text">Text</option>
              <option value="date">Date</option>
            </select>
          </label>
        </div>
      );

    default:
      return <p className="settings-note">This type has nothing to configure.</p>;
  }
}

interface Option {
  id: string;
  name: string;
  color: string;
  orderindex: number;
}

const PALETTE = ["#5b8def", "#c77dd8", "#43b581", "#e9a23b", "#ec5b5b", "#6b7686"];

function OptionsEditor({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const options = (config.options as Option[] | undefined) ?? [];

  function write(next: Option[]) {
    onChange({ ...config, options: next.map((option, index) => ({ ...option, orderindex: index })) });
  }

  return (
    <div className="settings-options">
      {options.map((option, index) => (
        <div className="settings-option" key={option.id}>
          <input
            className="settings-color"
            type="color"
            value={option.color}
            onChange={(event) =>
              write(options.map((o) => (o.id === option.id ? { ...o, color: event.target.value } : o)))
            }
            aria-label={`Colour of ${option.name}`}
          />
          <input
            className="settings-input"
            value={option.name}
            placeholder={`Option ${index + 1}`}
            onChange={(event) =>
              write(options.map((o) => (o.id === option.id ? { ...o, name: event.target.value } : o)))
            }
          />
          <button
            type="button"
            className="settings-icon danger"
            title="Remove option"
            onClick={() => write(options.filter((o) => o.id !== option.id))}
          >
            ×
          </button>
        </div>
      ))}

      <button
        type="button"
        className="settings-add"
        onClick={() =>
          write([
            ...options,
            {
              // Generated here, not derived from the name: renaming an option
              // must not detach every task that holds it.
              id: crypto.randomUUID(),
              name: "",
              color: PALETTE[options.length % PALETTE.length]!,
              orderindex: options.length,
            },
          ])
        }
      >
        + Add option
      </button>
    </div>
  );
}
