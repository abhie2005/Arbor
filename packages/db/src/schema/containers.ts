import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { containerKind, permission, principalKind } from "./enums";
import { users, workspaces } from "./workspaces";

/**
 * Space, Folder, and List in one self-referencing tree.
 *
 * Modelling them separately would mean writing every query twice — once for a
 * list inside a folder and once for a folder-less list sitting directly in a
 * space — and would make "subfolders" a schema migration rather than just
 * another row. Depth is unconstrained by design.
 *
 * `position` is a fractional index (see @arbor/core/ordering), not an integer,
 * so reordering by drag writes exactly one row instead of renumbering siblings.
 */
export const containers = pgTable(
  "containers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => containers.id, {
      onDelete: "cascade",
    }),
    kind: containerKind("kind").notNull(),
    name: text("name").notNull(),
    icon: text("icon"),
    color: text("color"),
    description: text("description"),
    position: text("position").notNull(),
    /** When true, only principals with an explicit grant can see it. */
    isPrivate: boolean("is_private").notNull().default(false),
    /** Per-container overrides: enabled features, default view, task key prefix. */
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("containers_workspace_idx").on(t.workspaceId, t.kind),
    index("containers_parent_idx").on(t.parentId, t.position),
    index("containers_archived_idx").on(t.workspaceId, t.archivedAt),
  ],
);

/**
 * An explicit share of a container to a user or group.
 *
 * Grants are the source of truth and are cheap to write. They are never read on
 * the hot path — `accessIndex` below is what queries actually join against.
 */
export const grants = pgTable(
  "grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    containerId: uuid("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
    principalKind: principalKind("principal_kind").notNull(),
    principalId: uuid("principal_id").notNull(),
    permission: permission("permission").notNull().default("edit"),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("grants_unique").on(t.containerId, t.principalKind, t.principalId),
    index("grants_principal_idx").on(t.principalId),
  ],
);

/**
 * Materialized "which user can reach which list, at what permission".
 *
 * Resolving access by walking parents at query time costs one join per level of
 * nesting on every single view query. Instead a background job flattens grants +
 * inheritance into this table whenever a grant changes or a container moves, and
 * every task query becomes one inner join against it.
 *
 * Rebuild is idempotent: delete by (principal, workspace) and re-insert.
 */
export const accessIndex = pgTable(
  "access_index",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** A user id. Group grants are expanded into per-user rows during the rebuild. */
    principalId: uuid("principal_id").notNull(),
    /** Always a container of kind `list` — tasks only ever live in lists. */
    listId: uuid("list_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
    permission: permission("permission").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.principalId, t.listId] }),
    index("access_index_lookup").on(t.principalId, t.workspaceId),
    index("access_index_list_idx").on(t.listId),
  ],
);

export const containersRelations = relations(containers, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [containers.workspaceId],
    references: [workspaces.id],
  }),
  parent: one(containers, {
    fields: [containers.parentId],
    references: [containers.id],
    relationName: "container_tree",
  }),
  children: many(containers, { relationName: "container_tree" }),
  grants: many(grants),
}));

export const grantsRelations = relations(grants, ({ one }) => ({
  container: one(containers, {
    fields: [grants.containerId],
    references: [containers.id],
  }),
}));

export type Container = typeof containers.$inferSelect;
export type NewContainer = typeof containers.$inferInsert;
export type Grant = typeof grants.$inferSelect;
export type AccessRow = typeof accessIndex.$inferSelect;
