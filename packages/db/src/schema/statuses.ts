import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { containers } from "./containers";
import { statusGroup } from "./enums";
import { workspaces } from "./workspaces";

/**
 * A reusable set of statuses. Attached to a container (space, folder, or list)
 * or left unattached as a workspace-level template — "Scrum", "Kanban",
 * "Marketing" — that new containers can be created from.
 *
 * Resolution order for a list's effective set: its own set, else its nearest
 * ancestor's, else the workspace default. Resolved once in @arbor/core, cached,
 * never re-derived ad hoc.
 */
export const statusSets = pgTable(
  "status_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    containerId: uuid("container_id").references(() => containers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isTemplate: boolean("is_template").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("status_sets_container_idx").on(t.containerId),
    index("status_sets_template_idx").on(t.workspaceId, t.isTemplate),
  ],
);

export const statuses = pgTable(
  "statuses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    statusSetId: uuid("status_set_id")
      .notNull()
      .references(() => statusSets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * The group — not the name — is what the rest of the system reasons about.
     * A team's custom "Shipping" status is `active`; completion percentages,
     * "show closed" filters, and burndown all read this column.
     */
    group: statusGroup("group").notNull(),
    color: text("color").notNull().default("#6B7686"),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("statuses_set_idx").on(t.statusSetId, t.position),
    uniqueIndex("statuses_name_key").on(t.statusSetId, t.name),
  ],
);

export const statusSetsRelations = relations(statusSets, ({ one, many }) => ({
  container: one(containers, {
    fields: [statusSets.containerId],
    references: [containers.id],
  }),
  statuses: many(statuses),
}));

export const statusesRelations = relations(statuses, ({ one }) => ({
  set: one(statusSets, {
    fields: [statuses.statusSetId],
    references: [statusSets.id],
  }),
}));

export type StatusSet = typeof statusSets.$inferSelect;
export type Status = typeof statuses.$inferSelect;
