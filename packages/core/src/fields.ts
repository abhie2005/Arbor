/**
 * The custom-field type system.
 *
 * Everything about a field type is declared once, here, and read everywhere
 * else: which typed column its values live in, which filter operators make
 * sense for it, and what its `typeConfig` blob is allowed to contain.
 *
 * **Why this module exists at all.** Before it, the view compiler chose the
 * storage column from the *JavaScript type of the filter value* — so a number
 * filter against a text field wrote `value_num = 3`, matched nothing, and
 * reported an empty view rather than an error (the sharp edge recorded in
 * D-013). Inference from a value is guessing. The field already knows its own
 * type; the only correct answer is to ask it.
 *
 * Pure and dependency-free, like the rest of @arbor/core: the same checks run
 * in the API boundary, in the seed script, and in the browser before a form is
 * submitted, because none of them can reach a database from here.
 */

import type { FilterOp } from "./views/types";

/** Mirrors the `field_type` enum in the database, in the same order. */
export type FieldType =
  | "short_text"
  | "text"
  | "number"
  | "currency"
  | "checkbox"
  | "date"
  | "drop_down"
  | "labels"
  | "url"
  | "email"
  | "phone"
  | "users"
  | "tasks"
  | "location"
  | "rating"
  | "manual_progress"
  | "automatic_progress"
  | "formula"
  | "relationship"
  | "rollup";

export const FIELD_TYPES = [
  "short_text",
  "text",
  "number",
  "currency",
  "checkbox",
  "date",
  "drop_down",
  "labels",
  "url",
  "email",
  "phone",
  "users",
  "tasks",
  "location",
  "rating",
  "manual_progress",
  "automatic_progress",
  "formula",
  "relationship",
  "rollup",
] as const satisfies readonly FieldType[];

/** The column on `field_values` a type's values are stored in. */
export type ValueColumn = "value_text" | "value_num" | "value_date" | "value_bool" | "value_json";

export class FieldError extends Error {}

const TEXT_OPS = [
  "eq",
  "neq",
  "contains",
  "notContains",
  "in",
  "nin",
  "isNull",
  "isNotNull",
] as const satisfies readonly FilterOp[];

const ORDERED_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "nin",
  "isNull",
  "isNotNull",
] as const satisfies readonly FilterOp[];

/** Set membership: "is one of", never "is greater than". */
const SET_OPS = ["eq", "neq", "in", "nin", "isNull", "isNotNull"] as const satisfies readonly FilterOp[];

const PRESENCE_OPS = ["isNull", "isNotNull"] as const satisfies readonly FilterOp[];

export interface FieldTypeMeta {
  label: string;
  /**
   * Where values live. `formula` and `rollup` are absent — their column
   * depends on the declared result type, so they resolve through
   * `fieldValueColumn()` instead.
   */
  column: ValueColumn | "byResultType";
  /** Values are a JSON array; filters become containment tests, not comparisons. */
  multi: boolean;
  /** Computed by the system. A user may not write one directly. */
  derived: boolean;
  ops: readonly FilterOp[];
}

export const FIELD_TYPE_META: Record<FieldType, FieldTypeMeta> = {
  short_text: { label: "Text", column: "value_text", multi: false, derived: false, ops: TEXT_OPS },
  text: { label: "Long text", column: "value_text", multi: false, derived: false, ops: TEXT_OPS },
  number: { label: "Number", column: "value_num", multi: false, derived: false, ops: ORDERED_OPS },
  currency: { label: "Currency", column: "value_num", multi: false, derived: false, ops: ORDERED_OPS },
  checkbox: { label: "Checkbox", column: "value_bool", multi: false, derived: false, ops: SET_OPS },
  date: { label: "Date", column: "value_date", multi: false, derived: false, ops: ORDERED_OPS },
  drop_down: { label: "Dropdown", column: "value_text", multi: false, derived: false, ops: SET_OPS },
  labels: { label: "Labels", column: "value_json", multi: true, derived: false, ops: SET_OPS },
  url: { label: "URL", column: "value_text", multi: false, derived: false, ops: TEXT_OPS },
  email: { label: "Email", column: "value_text", multi: false, derived: false, ops: TEXT_OPS },
  phone: { label: "Phone", column: "value_text", multi: false, derived: false, ops: TEXT_OPS },
  users: { label: "People", column: "value_json", multi: true, derived: false, ops: SET_OPS },
  tasks: { label: "Tasks", column: "value_json", multi: true, derived: false, ops: SET_OPS },
  // No sensible ordering and no useful equality — you filter on whether a
  // location was set, and look at it on the task.
  location: { label: "Location", column: "value_json", multi: false, derived: false, ops: PRESENCE_OPS },
  rating: { label: "Rating", column: "value_num", multi: false, derived: false, ops: ORDERED_OPS },
  manual_progress: {
    label: "Progress (manual)",
    column: "value_num",
    multi: false,
    derived: false,
    ops: ORDERED_OPS,
  },
  automatic_progress: {
    label: "Progress (automatic)",
    column: "value_num",
    multi: false,
    derived: true,
    ops: ORDERED_OPS,
  },
  formula: { label: "Formula", column: "byResultType", multi: false, derived: true, ops: ORDERED_OPS },
  relationship: {
    label: "Relationship",
    column: "value_json",
    multi: true,
    derived: false,
    ops: SET_OPS,
  },
  rollup: { label: "Rollup", column: "byResultType", multi: false, derived: true, ops: ORDERED_OPS },
};

export function isFieldType(value: unknown): value is FieldType {
  return typeof value === "string" && value in FIELD_TYPE_META;
}

/** A dropdown or label choice. `id` is what `field_values` stores, never the name. */
export interface FieldOption {
  id: string;
  name: string;
  color: string;
  orderindex: number;
}

export type ResultType = "number" | "text" | "date";

export interface FieldConfigs {
  short_text: { maxLength?: number };
  text: { maxLength?: number };
  number: { precision?: number };
  currency: { code: string; precision: number };
  checkbox: Record<string, never>;
  date: { includeTime: boolean };
  drop_down: { options: FieldOption[] };
  labels: { options: FieldOption[] };
  url: Record<string, never>;
  email: Record<string, never>;
  phone: Record<string, never>;
  users: { multiple: boolean };
  tasks: { multiple: boolean };
  location: Record<string, never>;
  rating: { max: number };
  manual_progress: { start: number; end: number };
  automatic_progress: Record<string, never>;
  formula: { expression: string; resultType: ResultType };
  relationship: { targetContainerId: string | null; multiple: boolean };
  rollup: {
    relationshipFieldId: string;
    targetFieldId: string;
    aggregation: "sum" | "avg" | "min" | "max" | "count";
    resultType: ResultType;
  };
}

export type FieldConfig<T extends FieldType = FieldType> = FieldConfigs[T];

/** The minimum a caller must know about a field to store or filter its values. */
export interface FieldDefinition<T extends FieldType = FieldType> {
  id: string;
  type: T;
  typeConfig: FieldConfig<T>;
}

/**
 * Which typed column this field reads and writes.
 *
 * Derived types are the only ones that need the config: a formula returning a
 * date has to sort as a date, not as the text "2026-09-02", or every ordering
 * is lexicographic and wrong across year boundaries.
 */
export function fieldValueColumn(field: Pick<FieldDefinition, "type" | "typeConfig">): ValueColumn {
  const meta = FIELD_TYPE_META[field.type];
  if (!meta) throw new FieldError(`Unknown field type: ${String(field.type)}`);
  if (meta.column !== "byResultType") return meta.column;

  const resultType = (field.typeConfig as { resultType?: unknown } | undefined)?.resultType;
  switch (resultType) {
    case "text":
      return "value_text";
    case "date":
      return "value_date";
    default:
      return "value_num";
  }
}

export function fieldSupportsOp(type: FieldType, op: FilterOp): boolean {
  const meta = FIELD_TYPE_META[type];
  if (!meta) return false;
  return meta.ops.includes(op);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates and normalizes a `typeConfig` blob.
 *
 * Hand-written rather than delegated to a schema library on purpose (D-041):
 * every one of these needs a domain-specific message a generic validator would
 * not produce, and @arbor/core ships to the browser.
 *
 * Returns a *new* object containing only known keys — an unrecognized key is
 * dropped rather than persisted, so a stale client cannot smuggle state into
 * the blob and have it survive a round trip.
 */
export function parseFieldConfig<T extends FieldType>(
  type: T,
  raw: unknown,
): FieldConfig<T> {
  if (!isFieldType(type)) throw new FieldError(`Unknown field type: ${String(type)}`);

  const input = asObject(raw, "typeConfig");

  switch (type) {
    case "short_text":
    case "text": {
      const maxLength = optionalInt(input.maxLength, "maxLength", 1, 100_000);
      return (maxLength === undefined ? {} : { maxLength }) as FieldConfig<T>;
    }

    case "number": {
      const precision = optionalInt(input.precision, "precision", 0, 8);
      return (precision === undefined ? {} : { precision }) as FieldConfig<T>;
    }

    case "currency": {
      const code = typeof input.code === "string" ? input.code.toUpperCase() : "USD";
      if (!CURRENCY_RE.test(code)) {
        throw new FieldError(`Currency code must be a three-letter ISO 4217 code, got "${code}"`);
      }
      return { code, precision: optionalInt(input.precision, "precision", 0, 4) ?? 2 } as FieldConfig<T>;
    }

    case "date":
      return { includeTime: input.includeTime === true } as FieldConfig<T>;

    case "drop_down":
    case "labels":
      return { options: parseOptions(input.options) } as FieldConfig<T>;

    case "users":
    case "tasks":
      return { multiple: input.multiple !== false } as FieldConfig<T>;

    case "rating":
      return { max: optionalInt(input.max, "max", 1, 10) ?? 5 } as FieldConfig<T>;

    case "manual_progress": {
      const start = optionalNumber(input.start, "start") ?? 0;
      const end = optionalNumber(input.end, "end") ?? 100;
      if (end <= start) {
        throw new FieldError(`A progress field needs end greater than start (got ${start}…${end})`);
      }
      return { start, end } as FieldConfig<T>;
    }

    case "formula": {
      const expression = typeof input.expression === "string" ? input.expression.trim() : "";
      if (!expression) throw new FieldError("A formula field needs an expression");
      return { expression, resultType: parseResultType(input.resultType) } as FieldConfig<T>;
    }

    case "relationship": {
      const target = input.targetContainerId;
      if (target != null && !(typeof target === "string" && UUID_RE.test(target))) {
        throw new FieldError("targetContainerId must be a uuid or null");
      }
      return {
        targetContainerId: (target as string | null) ?? null,
        multiple: input.multiple !== false,
      } as FieldConfig<T>;
    }

    case "rollup": {
      const relationshipFieldId = requireUuid(input.relationshipFieldId, "relationshipFieldId");
      const targetFieldId = requireUuid(input.targetFieldId, "targetFieldId");
      const aggregation = input.aggregation ?? "sum";
      if (!["sum", "avg", "min", "max", "count"].includes(String(aggregation))) {
        throw new FieldError(`Unknown rollup aggregation: ${String(aggregation)}`);
      }
      return {
        relationshipFieldId,
        targetFieldId,
        aggregation,
        resultType: parseResultType(input.resultType),
      } as FieldConfig<T>;
    }

    // Types with nothing to configure. Returning `{}` rather than passing the
    // input through is what makes the "drop unknown keys" rule hold for them too.
    case "checkbox":
    case "url":
    case "email":
    case "phone":
    case "location":
    case "automatic_progress":
      return {} as FieldConfig<T>;

    default: {
      const exhaustive: never = type;
      throw new FieldError(`No config parser for ${String(exhaustive)}`);
    }
  }
}

/**
 * Validates a value a user is trying to store, and normalizes it to the shape
 * the storage column expects.
 *
 * `null` always passes: clearing a field is legal for every type.
 */
export function parseFieldValue(
  field: Pick<FieldDefinition, "type" | "typeConfig">,
  value: unknown,
): unknown {
  const meta = FIELD_TYPE_META[field.type];
  if (!meta) throw new FieldError(`Unknown field type: ${String(field.type)}`);
  if (value === null || value === undefined || value === "") return null;

  if (meta.derived) {
    throw new FieldError(`${meta.label} is computed by the system and cannot be set directly`);
  }

  switch (field.type) {
    case "short_text":
    case "text": {
      const text = requireString(value, meta.label);
      const max = (field.typeConfig as FieldConfigs["text"]).maxLength;
      if (max !== undefined && text.length > max) {
        throw new FieldError(`${meta.label} is limited to ${max} characters`);
      }
      return text;
    }

    case "url": {
      const text = requireString(value, meta.label);
      try {
        // Rejects "javascript:alert(1)" as much as it rejects nonsense: a URL
        // field's value ends up in an href.
        const url = new URL(text);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new FieldError(`A URL field accepts http and https only, got "${url.protocol}"`);
        }
        return url.toString();
      } catch (error) {
        if (error instanceof FieldError) throw error;
        throw new FieldError(`"${text}" is not a valid URL`);
      }
    }

    case "email": {
      const text = requireString(value, meta.label);
      if (!EMAIL_RE.test(text)) throw new FieldError(`"${text}" is not a valid email address`);
      return text;
    }

    case "phone":
      return requireString(value, meta.label);

    case "number":
    case "currency":
      return requireFiniteNumber(value, meta.label);

    case "rating": {
      const n = requireFiniteNumber(value, meta.label);
      const max = (field.typeConfig as FieldConfigs["rating"]).max ?? 5;
      if (!Number.isInteger(n) || n < 0 || n > max) {
        throw new FieldError(`A rating must be a whole number between 0 and ${max}`);
      }
      return n;
    }

    case "manual_progress": {
      const n = requireFiniteNumber(value, meta.label);
      const { start = 0, end = 100 } = field.typeConfig as FieldConfigs["manual_progress"];
      if (n < start || n > end) {
        throw new FieldError(`Progress must be between ${start} and ${end}`);
      }
      return n;
    }

    case "checkbox":
      if (typeof value !== "boolean") throw new FieldError("A checkbox value must be true or false");
      return value;

    case "date": {
      const date = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(date.getTime())) throw new FieldError(`"${String(value)}" is not a date`);
      return date;
    }

    case "drop_down": {
      const id = requireString(value, meta.label);
      const { options } = field.typeConfig as FieldConfigs["drop_down"];
      if (!options.some((option) => option.id === id)) {
        throw new FieldError(`"${id}" is not one of this field's options`);
      }
      return id;
    }

    case "labels": {
      const ids = requireStringArray(value, meta.label);
      const { options } = field.typeConfig as FieldConfigs["labels"];
      for (const id of ids) {
        if (!options.some((option) => option.id === id)) {
          throw new FieldError(`"${id}" is not one of this field's options`);
        }
      }
      return dedupe(ids);
    }

    case "users":
    case "tasks":
    case "relationship": {
      const ids = requireStringArray(value, meta.label).map((id) => requireUuid(id, meta.label));
      const multiple = (field.typeConfig as { multiple?: boolean }).multiple !== false;
      if (!multiple && ids.length > 1) {
        throw new FieldError(`${meta.label} accepts a single value`);
      }
      return dedupe(ids);
    }

    case "location": {
      const point = asObject(value, meta.label);
      const lat = requireFiniteNumber(point.lat, "lat");
      const lng = requireFiniteNumber(point.lng, "lng");
      if (lat < -90 || lat > 90) throw new FieldError("Latitude must be between -90 and 90");
      if (lng < -180 || lng > 180) throw new FieldError("Longitude must be between -180 and 180");
      return { lat, lng, label: typeof point.label === "string" ? point.label : null };
    }

    // Unreachable — the `derived` guard above rejects these first. Listed so
    // the exhaustiveness check still covers every member of the union.
    case "automatic_progress":
    case "formula":
    case "rollup":
      throw new FieldError(`${meta.label} is computed by the system and cannot be set directly`);

    default: {
      const exhaustive: never = field.type;
      throw new FieldError(`No value parser for ${String(exhaustive)}`);
    }
  }
}

/**
 * The API-boundary check the compiler was missing (D-013).
 *
 * A filter is rejected when the operator makes no sense for the type, or when
 * the value cannot be coerced to what the storage column holds. Rejecting is
 * the whole point: the previous behaviour — compile it anyway and return zero
 * rows — is indistinguishable from "nothing matched", which is why the bug
 * survived as long as it did.
 *
 * Returns the value coerced for comparison, which is not always the value the
 * field would *store*: a `contains` on a dropdown searches option ids as text,
 * and `in` carries an array whose elements are each checked individually.
 */
export function parseFilterValue(
  field: Pick<FieldDefinition, "type" | "typeConfig">,
  op: FilterOp,
  value: unknown,
): unknown {
  const meta = FIELD_TYPE_META[field.type];
  if (!meta) throw new FieldError(`Unknown field type: ${String(field.type)}`);

  if (!meta.ops.includes(op)) {
    throw new FieldError(
      `Operator "${op}" does not apply to a ${meta.label} field (supported: ${meta.ops.join(", ")})`,
    );
  }

  if (op === "isNull" || op === "isNotNull") return undefined;

  if (op === "in" || op === "nin") {
    if (!Array.isArray(value) || value.length === 0) {
      throw new FieldError(`Operator "${op}" needs a non-empty array`);
    }
    return value.map((entry) => comparisonValue(field, meta, entry));
  }

  if (op === "between") {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new FieldError('Operator "between" needs a two-element array');
    }
    return value.map((entry) => comparisonValue(field, meta, entry));
  }

  if (op === "contains" || op === "notContains") {
    // Substring search is a text operation whatever the column is named.
    return requireString(value, meta.label);
  }

  return comparisonValue(field, meta, value);
}

/**
 * One element of a comparison. Multi-value fields compare against a single
 * member — "assignee is Riley" means the array contains Riley, not that the
 * whole array equals her.
 */
function comparisonValue(
  field: Pick<FieldDefinition, "type" | "typeConfig">,
  meta: FieldTypeMeta,
  value: unknown,
): unknown {
  if (value === null) return null;

  if (meta.multi) {
    // A membership test carries a bare id, not an array, so it cannot go
    // through parseFieldValue — that one validates the whole set.
    const id = requireString(value, meta.label);
    if (field.type === "labels") {
      const { options } = field.typeConfig as FieldConfigs["labels"];
      if (!options.some((option) => option.id === id)) {
        throw new FieldError(`"${id}" is not one of this field's options`);
      }
      return id;
    }
    return requireUuid(id, meta.label);
  }

  if (meta.derived) {
    // Derived values are still filterable; they just cannot be written. Coerce
    // against the result column rather than refusing.
    return coerceToColumn(fieldValueColumn(field), value, meta.label);
  }

  return parseFieldValue(field, value);
}

function coerceToColumn(column: ValueColumn, value: unknown, label: string): unknown {
  switch (column) {
    case "value_num":
      return requireFiniteNumber(value, label);
    case "value_date": {
      const date = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(date.getTime())) throw new FieldError(`"${String(value)}" is not a date`);
      return date;
    }
    case "value_bool":
      if (typeof value !== "boolean") throw new FieldError(`${label} expects true or false`);
      return value;
    default:
      return requireString(value, label);
  }
}

// --- small validators -------------------------------------------------------

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FieldError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FieldError(`${label} expects a non-empty string`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, label: string): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => requireString(item, label));
}

function requireFiniteNumber(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new FieldError(`${label} expects a number, got "${String(value)}"`);
  return n;
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new FieldError(`${label} expects a uuid, got "${String(value)}"`);
  }
  return value;
}

function optionalInt(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = requireFiniteNumber(value, label);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new FieldError(`${label} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireFiniteNumber(value, label);
}

function parseResultType(value: unknown): ResultType {
  if (value === undefined || value === null) return "number";
  if (value === "number" || value === "text" || value === "date") return value;
  throw new FieldError(`resultType must be number, text, or date — got "${String(value)}"`);
}

/**
 * Options carry generated ids because the *name* is what users rename. Storing
 * the name in `field_values` would mean renaming "S1" to "Sev 1" silently
 * detaches every task that had it.
 */
function parseOptions(raw: unknown): FieldOption[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new FieldError("A choice field needs at least one option");
  }

  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  const options = raw.map((entry, index) => {
    const option = asObject(entry, `option ${index + 1}`);
    const id = requireUuid(option.id, `option ${index + 1} id`);
    const name = requireString(option.name, `option ${index + 1} name`);
    const color = typeof option.color === "string" ? option.color : "#6B7686";

    if (!HEX_COLOR_RE.test(color)) {
      throw new FieldError(`Option "${name}" has an invalid colour: ${color}`);
    }
    if (seenIds.has(id)) throw new FieldError(`Duplicate option id: ${id}`);
    // Two options that read identically are indistinguishable in a filter menu.
    if (seenNames.has(name.toLowerCase())) throw new FieldError(`Duplicate option name: ${name}`);

    seenIds.add(id);
    seenNames.add(name.toLowerCase());

    return {
      id,
      name,
      color,
      orderindex: optionalInt(option.orderindex, "orderindex", 0, 10_000) ?? index,
    };
  });

  return options.sort((a, b) => a.orderindex - b.orderindex);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Field definitions by id, as the compiler and the mutation executor need them.
 *
 * Deliberately a map handed in by the caller rather than something either
 * module fetches: @arbor/core cannot reach a database, and making the catalog
 * an explicit input is what forces the API boundary to load the fields a view
 * references before compiling it.
 */
export type FieldCatalog = ReadonlyMap<string, FieldDefinition>;

export function indexFields(fields: readonly FieldDefinition[]): FieldCatalog {
  return new Map(fields.map((field) => [field.id, field]));
}
