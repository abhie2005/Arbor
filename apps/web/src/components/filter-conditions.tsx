"use client";

import {
  type FilterCondition,
  type FilterGroup,
  type FilterOp,
  type FilterableField,
  type ValueInput,
  isFilterClause,
  opNeedsValue,
  operatorLabel,
} from "@arbor/core";

/**
 * The condition menus, and the value controls under them.
 *
 * **Extracted from the filter bar because a rule's conditions are a
 * `FilterGroup`** (D-124) and an automation that grew its own condition editor
 * would be the second place in the app that decides what "status is Done"
 * looks like. The two screens differ only in where the value is kept: a view's
 * filter lives in the URL, because a filtered view is the thing people share,
 * and a rule's conditions live in a form until it is saved. So this takes a
 * group and a callback and owns neither.
 *
 * The contract that makes it worth having is the one the filter bar already
 * had: **every option offered here is one the server will accept**, because
 * the field menu, the operator menu and the value control all come from the
 * declaration the compiler validates against (D-054).
 */

export interface FilterOptionValues {
  statuses: { id: string; name: string; group: string; color: string }[];
  statusGroups: { id: string; name: string }[];
  priorities: { id: string; name: string }[];
  users: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  taskTypes: { id: string; name: string }[];
  /**
   * Optional, and the one set that is permission-scoped.
   *
   * Statuses, people and tags are workspace-wide, so loading them for a filter
   * bar names nothing private. Containers are not: listing every one of them is
   * exactly the leak D-123 was. A screen that supplies these has to have
   * filtered them already — the automations screen passes what the viewer
   * manages — and a screen that cannot say falls back to the text box the
   * filter bar has always shown for a list filter.
   */
  containers?: { id: string; name: string }[];
}

/**
 * The combinator, the chips, and the field menu — as a fragment.
 *
 * A fragment rather than a wrapper because the parent is the flex row: the
 * filter bar puts its "show closed" toggle beside these, and a div in between
 * would make two rows out of one.
 */
export function ConditionEditor({
  fields,
  values,
  group,
  onChange,
  addLabel = "+ Filter",
}: {
  fields: FilterableField[];
  values: FilterOptionValues;
  group: FilterGroup;
  onChange: (next: FilterGroup) => void;
  addLabel?: string;
}) {
  function replace(index: number, condition: FilterCondition) {
    onChange({
      ...group,
      conditions: group.conditions.map((c, i) => (i === index ? condition : c)),
    });
  }

  function remove(index: number) {
    onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== index) });
  }

  return (
    <>
      {group.conditions.length > 1 ? (
        <button
          type="button"
          className="filter-combinator"
          title="Match all conditions, or any of them"
          onClick={() => onChange({ ...group, op: group.op === "AND" ? "OR" : "AND" })}
        >
          {group.op === "AND" ? "All" : "Any"}
        </button>
      ) : null}

      {/* Leaf conditions only. A nested clause is a renderer's own scope
          (D-068) — it is not something anyone typed here, and offering to
          remove it would break the screen it is holding together. */}
      {group.conditions.map((node, index) => {
        if (isFilterClause(node)) return null;
        const condition = node;
        const field = fields.find((f) => f.ref === condition.field);
        return (
          <ConditionChip
            key={`${condition.field}-${index}`}
            condition={condition}
            field={field}
            fields={fields}
            values={values}
            onChange={(next) => replace(index, next)}
            onRemove={() => remove(index)}
          />
        );
      })}

      <FieldPicker
        fields={fields}
        label={addLabel}
        onPick={(field) => {
          const op = field.ops[0]!;
          onChange({
            ...group,
            conditions: [
              ...group.conditions,
              opNeedsValue(op)
                ? { field: field.ref, op, value: defaultValue(field, values) }
                : { field: field.ref, op },
            ],
          });
        }}
      />

      {group.conditions.length > 0 ? (
        <button
          type="button"
          className="filter-clear"
          onClick={() => onChange({ ...group, conditions: [] })}
        >
          Clear
        </button>
      ) : null}
    </>
  );
}

function ConditionChip({
  condition,
  field,
  fields,
  values,
  onChange,
  onRemove,
}: {
  condition: FilterCondition;
  field: FilterableField | undefined;
  fields: FilterableField[];
  values: FilterOptionValues;
  onChange: (next: FilterCondition) => void;
  onRemove: () => void;
}) {
  // A saved view can reference a field that has since been deleted. Say so
  // rather than rendering an empty menu that looks like a bug.
  if (!field) {
    return (
      <span className="filter-chip missing">
        <span>Unknown field</span>
        <code>{String(condition.field)}</code>
        <button type="button" onClick={onRemove} title="Remove">
          ×
        </button>
      </span>
    );
  }

  return (
    <span className="filter-chip">
      <select
        value={condition.field}
        aria-label="Field"
        onChange={(event) => {
          const next = fields.find((f) => f.ref === event.target.value);
          if (!next) return;
          // Operators and values belong to a field. Carrying them across would
          // build exactly the filter the compiler exists to reject.
          const op = next.ops[0]!;
          onChange(
            opNeedsValue(op)
              ? { field: next.ref, op, value: defaultValue(next, values) }
              : { field: next.ref, op },
          );
        }}
      >
        {fields.map((option) => (
          <option key={option.ref} value={option.ref}>
            {option.label}
          </option>
        ))}
      </select>

      <select
        value={condition.op}
        aria-label="Operator"
        onChange={(event) => {
          const op = event.target.value as FilterOp;
          onChange(
            opNeedsValue(op)
              ? { field: field.ref, op, value: condition.value ?? defaultValue(field, values) }
              : { field: field.ref, op },
          );
        }}
      >
        {field.ops.map((op) => (
          <option key={op} value={op}>
            {operatorLabel(op, field.input)}
          </option>
        ))}
      </select>

      {opNeedsValue(condition.op) ? (
        <ValueControl
          input={field.input}
          choices={field.options}
          value={condition.value}
          values={values}
          onChange={(value) => onChange({ field: field.ref, op: condition.op, value })}
        />
      ) : null}

      <button type="button" onClick={onRemove} title="Remove filter">
        ×
      </button>
    </span>
  );
}

/**
 * One value, in whatever control its `ValueInput` calls for.
 *
 * Keyed on the input rather than on a `FilterableField`, because an
 * automation's actions need the same controls for something that is not a
 * filter at all — "set status to Done" is the status menu this renders, and a
 * second status menu beside it would be a second set of statuses to keep right.
 */
export function ValueControl({
  input,
  choices,
  value,
  values,
  onChange,
}: {
  input: ValueInput;
  choices?: { id: string; name: string }[];
  value: unknown;
  values: FilterOptionValues;
  onChange: (value: unknown) => void;
}) {
  const options = optionsFor(input, choices, values);

  if (options) {
    return (
      <select
        value={String(value ?? "")}
        aria-label="Value"
        onChange={(event) => onChange(coerce(input, event.target.value))}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    );
  }

  if (input === "date") {
    return (
      <input
        type="date"
        aria-label="Value"
        value={typeof value === "string" ? value.slice(0, 10) : ""}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (input === "number") {
    return (
      <input
        type="number"
        aria-label="Value"
        value={typeof value === "number" ? value : ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? null : Number(event.target.value))
        }
      />
    );
  }

  if (input === "none") return null;

  return (
    <input
      type="text"
      aria-label="Value"
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function optionsFor(
  input: ValueInput,
  choices: { id: string; name: string }[] | undefined,
  values: FilterOptionValues,
): { id: string; name: string }[] | null {
  switch (input) {
    // A choice field defines its own legal values, so they come from the field
    // rather than from anything the workspace holds.
    case "choice":
      return choices ?? [];
    case "status":
      return values.statuses;
    case "statusGroup":
      return values.statusGroups;
    case "priority":
      return values.priorities;
    case "user":
      return values.users;
    case "tag":
      return values.tags;
    case "taskType":
      return values.taskTypes;
    // Only when the screen filtered them. See `containers` above.
    case "container":
      return values.containers ?? null;
    default:
      return null;
  }
}

/** Priority is an integer column; every other picker carries an id. */
export function coerce(input: ValueInput, raw: string): unknown {
  return input === "priority" ? Number(raw) : raw;
}

/** What a freshly added condition or action holds before anyone chooses. */
export function defaultValueFor(
  input: ValueInput,
  choices: { id: string; name: string }[] | undefined,
  values: FilterOptionValues,
): unknown {
  const options = optionsFor(input, choices, values);
  if (options) return coerce(input, options[0]?.id ?? "");
  if (input === "number") return 0;
  if (input === "date") return new Date().toISOString().slice(0, 10);
  return "";
}

function defaultValue(field: FilterableField, values: FilterOptionValues): unknown {
  return defaultValueFor(field.input, field.options, values);
}

/**
 * The "+ Filter" control is itself the field menu.
 *
 * It was briefly a button that swapped in an autofocused `<select>`, which
 * raced: `autoFocus` and the select's own `onBlur` could fire in either order,
 * so the menu sometimes closed the instant it opened. The open/close state was
 * never carrying its weight — a select with a placeholder is one control, no
 * state, and nothing to race.
 */
function FieldPicker({
  fields,
  label,
  onPick,
}: {
  fields: FilterableField[];
  label: string;
  onPick: (field: FilterableField) => void;
}) {
  const builtins = fields.filter((f) => !f.custom);
  const custom = fields.filter((f) => f.custom);

  return (
    <select
      className="filter-add"
      value=""
      aria-label="Add a filter"
      onChange={(event) => {
        const field = fields.find((f) => f.ref === event.target.value);
        if (field) onPick(field);
      }}
    >
      <option value="">{label}</option>
      <optgroup label="Fields">
        {builtins.map((field) => (
          <option key={field.ref} value={field.ref}>
            {field.label}
          </option>
        ))}
      </optgroup>
      {custom.length > 0 ? (
        <optgroup label="Custom fields">
          {custom.map((field) => (
            <option key={field.ref} value={field.ref}>
              {field.label}
            </option>
          ))}
        </optgroup>
      ) : null}
    </select>
  );
}
