import { relations } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { containers } from "./containers";
import { containerKind, viewType } from "./enums";
import { users, workspaces } from "./workspaces";

/**
 * A view is a saved query plus a renderer.
 *
 * Every view type — list, board, calendar, gantt — serializes to the same
 * `definition` object (see ViewDefinition in @arbor/core). Board view is simply
 * `grouping.field = "status"`. That is why adding a renderer costs days rather
 * than weeks: the query compiler is written once.
 *
 * `parentId` null means the Everything level: the view spans every list the
 * viewer can reach, which the compiler gets from the access index rather than
 * from a parent id.
 */
export const views = pgTable(
  "views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references(() => containers.id, { onDelete: "cascade" }),
    /** Null alongside a null parentId marks a workspace-wide (Everything) view. */
    parentKind: containerKind("parent_kind"),
    type: viewType("type").notNull(),
    name: text("name").notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    /** Null means shared with everyone who can see the parent; set means personal. */
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "cascade" }),
    position: text("position").notNull(),
    isDefault: text("is_default"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("views_parent_idx").on(t.parentId, t.position),
    index("views_workspace_idx").on(t.workspaceId, t.type),
    index("views_owner_idx").on(t.ownerId),
  ],
);

/**
 * A user's local tweaks to a shared view — an extra filter, a different sort —
 * without mutating what teammates see. The UI surfaces this as
 * "Unsaved · Save · Reset".
 */
export const viewOverrides = pgTable(
  "view_overrides",
  {
    viewId: uuid("view_id")
      .notNull()
      .references(() => views.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    patch: jsonb("patch").$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.viewId, t.userId] })],
);

export const viewsRelations = relations(views, ({ one, many }) => ({
  parent: one(containers, {
    fields: [views.parentId],
    references: [containers.id],
  }),
  owner: one(users, { fields: [views.ownerId], references: [users.id] }),
  overrides: many(viewOverrides),
}));

export type View = typeof views.$inferSelect;
export type NewView = typeof views.$inferInsert;
export type ViewOverride = typeof viewOverrides.$inferSelect;
