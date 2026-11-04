/**
 * What a form asks, and what a submission is allowed to say.
 *
 * Pure, and in core for the reason every rule here is: the thing that decides
 * what an **unauthenticated** writer may write must be testable without a
 * database in front of it. This is the only place in the codebase where a
 * request with no session causes a write, so the bound on that write is the
 * whole security story — and it is forty lines of pure function rather than a
 * condition buried in a route handler.
 *
 * **A declaration is a whitelist, not a hint** (D-142). A submission may fill
 * the fields a manager declared and nothing else: an undeclared key is a
 * refusal rather than a value quietly dropped, because the two failures look
 * identical from outside and only one of them is honest. The alternative —
 * accepting a `Record<string, unknown>` and writing what matches — is an
 * unauthenticated write to any column the task table has.
 */

/** The fields a form may offer. A closed list, and smaller than `TaskField`. */
export const FORMABLE_FIELDS = [
  { field: "name", label: "Name", input: "text", required: true },
  { field: "priority", label: "Priority", input: "priority", required: false },
  { field: "dueAt", label: "Due date", input: "date", required: false },
  { field: "startAt", label: "Start date", input: "date", required: false },
  { field: "points", label: "Points", input: "number", required: false },
] as const;

export type FormableField = (typeof FORMABLE_FIELDS)[number]["field"];

/**
 * Deliberately **not** every `TaskField`.
 *
 * `statusId`, `taskTypeId` and `homeListId` are omitted because a stranger
 * choosing where a task lands, or what state it arrives in, is a decision the
 * list's manager has already made by pointing the form at a list. `position`
 * and `parentTaskId` are structure rather than content. Adding one is a line
 * here plus a control, and it should be a line somebody has to write on
 * purpose.
 */
export const FORMABLE: readonly FormableField[] = FORMABLE_FIELDS.map((f) => f.field);

export interface FormFieldDeclaration {
  field: FormableField;
  /** What the public sees. Falls back to the field's own label when empty. */
  label: string;
  required: boolean;
}

export interface FormDefinition {
  fields: FormFieldDeclaration[];
}

export class FormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormError";
  }
}

function fail(problem: string): never {
  throw new FormError(problem);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A stored definition, validated.
 *
 * Stored JSON is untrusted input for the same reason a saved view's definition
 * is (D-018): it was written by a client at some point, and the row outlives
 * the code that wrote it.
 */
export function parseFormDefinition(value: unknown): FormDefinition {
  if (!isRecord(value)) fail("A form needs a definition");

  const raw = value.fields;
  if (!Array.isArray(raw)) fail("A form's fields must be a list");
  if (raw.length === 0) fail("A form with no fields asks nothing");
  if (raw.length > 25) fail("A form may ask at most 25 things");

  const seen = new Set<string>();
  const fields = raw.map((entry, index) => {
    if (!isRecord(entry)) fail(`Field ${index + 1} is not a field`);

    const field = entry.field;
    if (typeof field !== "string" || !FORMABLE.includes(field as FormableField)) {
      fail(`Field ${index + 1} names ${String(field)}, which a form may not ask for`);
    }
    // One question per field: two controls writing the same column is a form
    // that contradicts itself, and the second write would silently win.
    if (seen.has(field)) fail(`A form asks for ${field} twice`);
    seen.add(field);

    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const declared = FORMABLE_FIELDS.find((candidate) => candidate.field === field)!;

    return {
      field: field as FormableField,
      label: label || declared.label,
      // `name` is required whatever the declaration says: a task with no name
      // is a row nobody can find again.
      required: field === "name" ? true : entry.required === true,
    };
  });

  if (!fields.some((f) => f.field === "name")) fail("A form must ask for a name");

  return { fields };
}

/**
 * What a submission writes, bounded by what the form asked.
 *
 * Returns the values to put on the new task — the caller turns them into the
 * `createTask` operation, because building an operation needs ids this cannot
 * know (invariant 1 is the caller's to keep, and nothing here writes).
 */
export function parseSubmission(
  definition: FormDefinition,
  body: unknown,
): Record<string, unknown> {
  if (!isRecord(body)) fail("A submission must be a set of answers");

  const declared = new Map(definition.fields.map((f) => [f.field, f]));

  for (const key of Object.keys(body)) {
    // Refused, not dropped. A form that silently ignores half of what it was
    // sent is indistinguishable from one that accepted it, and the person who
    // finds out is whoever reads the task a week later.
    if (!declared.has(key as FormableField)) {
      fail(`This form does not ask for ${key}`);
    }
  }

  const values: Record<string, unknown> = {};

  for (const field of definition.fields) {
    const given = body[field.field];
    const empty = given === undefined || given === null || given === "";

    if (empty) {
      if (field.required) fail(`${field.label} is required`);
      continue;
    }

    values[field.field] = coerce(field.field, given, field.label);
  }

  return values;
}

/**
 * The value a column will take, or a refusal.
 *
 * A form is the one writer whose input is a string from a stranger, so this is
 * where "3" becomes 3 and "not a date" becomes a message rather than a
 * `null` that reads as "they left it blank".
 */
function coerce(field: FormableField, value: unknown, label: string): unknown {
  switch (field) {
    case "name": {
      const text = String(value).trim();
      if (!text) fail(`${label} is required`);
      if (text.length > 500) fail(`${label} is too long`);
      return text;
    }

    case "priority": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 4) fail(`${label} must be between 1 and 4`);
      return n;
    }

    case "points": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) fail(`${label} must be a number`);
      return n;
    }

    case "dueAt":
    case "startAt": {
      // A date from a form is a **calendar day** — midnight UTC, read in UTC
      // (invariant 9, D-067). A browser's local midnight would make the same
      // answer mean a different day either side of a timezone.
      const text = String(value).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`${label} must be a date`);
      const at = new Date(`${text}T00:00:00.000Z`);
      // **Round-tripped, not just parsed.** `new Date("2026-02-31")` is not
      // NaN — it rolls over to 3 March — so a shape check and a NaN check
      // between them still accept a day that does not exist and silently move
      // it. Somebody typing the wrong date should be told, not corrected.
      if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== text) {
        fail(`${label} is not a date that exists`);
      }
      return at.toISOString();
    }
  }
}
