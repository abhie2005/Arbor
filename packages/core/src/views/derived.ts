import { type FieldDefinition, FIELD_TYPE_META } from "../fields";

/**
 * What a derived field is, as an expression (D-151).
 *
 * Three field types have been declared, filterable and **empty** since Phase 1:
 * `automatic_progress`, `formula` and `rollup` write nothing to `field_values`,
 * so every read of one has always been null. This is where the first of them
 * stops being empty.
 *
 * **Computed on read, not materialized on write**, and that is the decision the
 * whole gap turned on. The alternative is a column kept up to date by a worker:
 * a subtask closing has to find every ancestor holding a progress field and
 * recompute it, a field being created has to backfill, and a missed event is a
 * number that is quietly wrong for a week. Read-time arithmetic cannot be
 * stale, needs no queue, and — because it is an *expression* rather than a
 * value — arrives in filtering, sorting, grouping and totalling at the same
 * moment it arrives in a cell, because all five already go through one place.
 *
 * The cost is honest: it cannot be indexed, so a filter on a derived field
 * scans. That is the trade this repo has already made for custom field values
 * in general (D-013's EAV), and the first derived type is a correlated count
 * over an indexed column — `tasks.parent_task_id`.
 *
 * **`formula` and `rollup` return null here**, which is what they have always
 * returned. They are not harder than this one by accident: a formula needs an
 * expression language, which is a parser, a precedence table and a closed set
 * of references that can never become SQL text (D-018's rule); a rollup needs
 * to resolve a relationship field and aggregate across it. Both are their own
 * piece of work, and shipping `automatic_progress` first is what proves the
 * mechanism they will use.
 */
export function derivedValueSql(
  field: Pick<FieldDefinition, "type">,
  taskAlias: string,
): string | null {
  if (!FIELD_TYPE_META[field.type]?.derived) return null;

  // The alias is written by this codebase and never by a caller, which is the
  // only reason it may be interpolated at all. The check is here so that stays
  // true the day somebody passes one through (D-018).
  if (!/^[a-z][a-z0-9_]*$/.test(taskAlias)) {
    throw new Error(`Not a table alias: ${taskAlias}`);
  }

  if (field.type !== "automatic_progress") return null;

  /**
   * How many of this task's subtasks are finished, as a percentage.
   *
   * **Null when there are none**, rather than zero: a task with no subtasks has
   * not made no progress, it has no answer, and a bar sitting at 0% is a claim
   * about work that does not exist. `trackedPercent` made the same call for the
   * same reason.
   *
   * Finished is `done` or `closed` — the pair `completed_at` is stamped for, so
   * "this task is complete" means one thing in the product. Archived and
   * deleted subtasks are not counted at all: they are not work remaining and
   * they are not work finished.
   */
  return `(SELECT CASE WHEN count(*) = 0 THEN NULL
             ELSE round(100.0 * count(*) FILTER (WHERE dst.group IN ('done','closed')) / count(*))
           END
           FROM tasks dsub
           LEFT JOIN statuses dst ON dst.id = dsub.status_id
           WHERE dsub.parent_task_id = ${taskAlias}.id
             AND dsub.deleted_at IS NULL
             AND dsub.archived_at IS NULL)`;
}
