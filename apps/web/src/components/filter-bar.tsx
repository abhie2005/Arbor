"use client";

import {
  type FilterCondition,
  type FilterGroup,
  type FilterOp,
  type FilterableField,
  type ValueInput,
  encodeFilters,
  opNeedsValue,
  operatorLabel,
} from "@arbor/core";
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/**
 * The filter bar.
 *
 * **The contract that makes it worth having:** every option offered here is one
 * the server will accept. The field menu, the operator menu, and the value
 * control all come from the same declaration the compiler validates against
 * (D-054), so it is not possible to build a filter, wait, and be told it was
 * never allowed.
 *
 * State lives in the URL, not in this component. A filtered view is the thing
 * people share — "everything overdue and unassigned" — and component state
 * makes exactly the useful views unshareable and loses them on reload.
 */

export interface FilterOptionValues {
  statuses: { id: string; name: string; group: string; color: string }[];
  statusGroups: { id: string; name: string }[];
  priorities: { id: string; name: string }[];
  users: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  taskTypes: { id: string; name: string }[];
}

export function FilterBar({
  fields,
  values,
  filters,
}: {
  fields: FilterableField[];
  values: FilterOptionValues;
  filters: FilterGroup;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function commit(next: FilterGroup) {
    const encoded = encodeFilters(next);
    const query = new URLSearchParams(params.toString());

    if (encoded) query.set("f", encoded);
    else query.delete("f");

    const search = query.toString();
    startTransition(() => {
      router.push(search ? `?${search}` : "?", { scroll: false });
    });
  }

  function replace(index: number, condition: FilterCondition) {
    commit({
      ...filters,
      conditions: filters.conditions.map((c, i) => (i === index ? condition : c)),
    });
  }

  function remove(index: number) {
    commit({ ...filters, conditions: filters.conditions.filter((_, i) => i !== index) });
  }

  return (
    <div className="filter-bar" data-pending={pending || undefined}>
      {filters.conditions.length > 1 ? (
        <button
          type="button"
          className="filter-combinator"
          title="Match all conditions, or any of them"
          onClick={() => commit({ ...filters, op: filters.op === "AND" ? "OR" : "AND" })}
        >
          {filters.op === "AND" ? "All" : "Any"}
        </button>
      ) : null}

      {filters.conditions.map((condition, index) => {
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
        onPick={(field) => {
          const op = field.ops[0]!;
          commit({
            ...filters,
            conditions: [
              ...filters.conditions,
              opNeedsValue(op)
                ? { field: field.ref, op, value: defaultValue(field, values) }
                : { field: field.ref, op },
            ],
          });
        }}
      />

      {filters.conditions.length > 0 ? (
        <button
          type="button"
          className="filter-clear"
          onClick={() => commit({ ...filters, conditions: [] })}
        >
          Clear
        </button>
      ) : null}

      <label className="filter-toggle">
        <input
          type="checkbox"
          checked={filters.showClosed === true}
          onChange={(event) => commit({ ...filters, showClosed: event.target.checked })}
        />
        <span>Show closed</span>
      </label>
    </div>
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
          field={field}
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

function ValueControl({
  field,
  value,
  values,
  onChange,
}: {
  field: FilterableField;
  value: unknown;
  values: FilterOptionValues;
  onChange: (value: unknown) => void;
}) {
  const input = field.input;
  const options = optionsFor(field, values);

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

function optionsFor(
  field: FilterableField,
  values: FilterOptionValues,
): { id: string; name: string }[] | null {
  switch (field.input) {
    // A choice field defines its own legal values, so they come from the field
    // rather than from anything the workspace holds.
    case "choice":
      return field.options ?? [];
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
    default:
      return null;
  }
}

/** Priority is an integer column; every other picker carries an id. */
function coerce(input: ValueInput, raw: string): unknown {
  return input === "priority" ? Number(raw) : raw;
}

function defaultValue(field: FilterableField, values: FilterOptionValues): unknown {
  const options = optionsFor(field, values);
  if (options) return coerce(field.input, options[0]?.id ?? "");
  if (field.input === "number") return 0;
  if (field.input === "date") return new Date().toISOString().slice(0, 10);
  return "";
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
  onPick,
}: {
  fields: FilterableField[];
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
      <option value="">+ Filter</option>
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
