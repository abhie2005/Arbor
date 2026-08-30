import { relations } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { containers } from "./containers";
import { fieldType } from "./enums";
import { taskTypes, tasks } from "./tasks";
import { workspaces } from "./workspaces";

/**
 * A custom field definition, attached to a container. A field defined on a
 * space is available to every list beneath it; one defined on a list is local.
 */
export const fields = pgTable(
  "fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Null means workspace-wide. */
    containerId: uuid("container_id").references(() => containers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: fieldType("type").notNull(),
    /**
     * Shape depends on `type`: dropdown options, currency precision and code,
     * progress start/end, formula expression, rollup target and aggregation.
     * Validated by a per-type zod schema in @arbor/core.
     */
    typeConfig: jsonb("type_config").$type<Record<string, unknown>>().notNull().default({}),
    description: text("description"),
    position: integer("position").notNull().default(0),
    hideFromGuests: boolean("hide_from_guests").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("fields_container_idx").on(t.containerId, t.position),
    index("fields_workspace_idx").on(t.workspaceId),
  ],
);

/**
 * Restricts a field to specific task types, so a Bug loads bug fields and a
 * Feature never renders them. Absence of rows means "applies to every type".
 */
export const fieldScopes = pgTable(
  "field_scopes",
  {
    fieldId: uuid("field_id")
      .notNull()
      .references(() => fields.id, { onDelete: "cascade" }),
    taskTypeId: uuid("task_type_id")
      .notNull()
      .references(() => taskTypes.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.fieldId, t.taskTypeId] })],
);

/**
 * Typed EAV. One row per (task, field), with the value in whichever column
 * matches the field's type.
 *
 * The alternative — a single JSONB blob on the task — ships faster but hits a
 * wall the first time someone sorts a view by a custom number field across
 * 100k tasks. Physical columns per field would be fastest and are unworkable:
 * runtime DDL and per-tenant schema drift.
 *
 * Derived types (formula, rollup, automatic_progress) write their computed
 * result here too, invalidated by the activity log, so views can filter and
 * sort them without recomputing at read time.
 */
export const fieldValues = pgTable(
  "field_values",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => fields.id, { onDelete: "cascade" }),

    valueText: text("value_text"),
    valueNum: doublePrecision("value_num"),
    valueDate: timestamp("value_date", { withTimezone: true }),
    valueBool: boolean("value_bool"),
    /** Multi-value and structured types: labels, users, tasks, location. */
    valueJson: jsonb("value_json").$type<unknown>(),

    /** Set for derived fields; null for user-entered ones. */
    computedAt: timestamp("computed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.fieldId] }),
    // One index per typed column: a view filtering on a custom field must not
    // fall back to a sequential scan.
    index("field_values_text_idx").on(t.fieldId, t.valueText),
    index("field_values_num_idx").on(t.fieldId, t.valueNum),
    index("field_values_date_idx").on(t.fieldId, t.valueDate),
    index("field_values_bool_idx").on(t.fieldId, t.valueBool),
    index("field_values_task_idx").on(t.taskId),
  ],
);

export const fieldsRelations = relations(fields, ({ one, many }) => ({
  container: one(containers, {
    fields: [fields.containerId],
    references: [containers.id],
  }),
  scopes: many(fieldScopes),
  values: many(fieldValues),
}));

export const fieldValuesRelations = relations(fieldValues, ({ one }) => ({
  task: one(tasks, { fields: [fieldValues.taskId], references: [tasks.id] }),
  field: one(fields, { fields: [fieldValues.fieldId], references: [fields.id] }),
}));

export type Field = typeof fields.$inferSelect;
export type NewField = typeof fields.$inferInsert;
export type FieldValue = typeof fieldValues.$inferSelect;
