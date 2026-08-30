import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { objectKind } from "./enums";
import { tasks } from "./tasks";
import { users, workspaces } from "./workspaces";

/**
 * Append-only event log. This is infrastructure, not a feature.
 *
 * Task history, the activity view, notification fan-out, automation triggers,
 * "time in status" reporting, and derived-field invalidation all read from
 * here. Nothing else in the system needs to know how to notify or recompute.
 *
 * `actorId` is null for automation-driven changes, with `automationId` set
 * instead — attributing a robot's edit to the user who tripped it makes the
 * history lie, and the history is the one thing this table exists to provide.
 */
export const activity = pgTable(
  "activity",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    automationId: uuid("automation_id"),

    objectKind: objectKind("object_kind").notNull(),
    objectId: uuid("object_id").notNull(),
    /** e.g. "task.created", "task.status_changed", "comment.added". */
    verb: text("verb").notNull(),
    /** Column or custom field id that changed, when the verb is a field update. */
    field: text("field"),
    oldValue: jsonb("old_value").$type<unknown>(),
    newValue: jsonb("new_value").$type<unknown>(),

    /** Denormalized so an activity feed for a list needs no join. */
    listId: uuid("list_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("activity_object_idx").on(t.objectKind, t.objectId, t.at),
    index("activity_workspace_idx").on(t.workspaceId, t.at),
    index("activity_list_idx").on(t.listId, t.at),
    index("activity_actor_idx").on(t.actorId, t.at),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    objectKind: objectKind("object_kind").notNull(),
    objectId: uuid("object_id").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, {
      onDelete: "cascade",
    }),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    /** Rich text as a portable JSON document, same schema as descriptions. */
    body: jsonb("body").$type<unknown>().notNull(),
    /** A comment can be an action item — cheap to build, disproportionately useful. */
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("comments_object_idx").on(t.objectKind, t.objectId, t.createdAt),
    index("comments_parent_idx").on(t.parentId),
    index("comments_assigned_idx").on(t.assignedTo),
  ],
);

export const commentReactions = pgTable(
  "comment_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
  },
  (t) => [index("comment_reactions_comment_idx").on(t.commentId)],
);

/**
 * Write-time fan-out for direct signals only — assigned, mentioned, replied.
 * Ambient activity is aggregated at read time from `activity`, because a task
 * with 200 watchers would otherwise write 200 rows per edit.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activityId: uuid("activity_id"),
    kind: text("kind").notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    /** Rendered summary, so the inbox needs no joins to display a row. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    isRead: boolean("is_read").notNull().default(false),
    readAt: timestamp("read_at", { withTimezone: true }),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_inbox_idx").on(t.userId, t.isRead, t.createdAt),
    index("notifications_task_idx").on(t.taskId),
  ],
);

export const commentsRelations = relations(comments, ({ one, many }) => ({
  author: one(users, { fields: [comments.authorId], references: [users.id] }),
  parent: one(comments, {
    fields: [comments.parentId],
    references: [comments.id],
    relationName: "comment_thread",
  }),
  replies: many(comments, { relationName: "comment_thread" }),
  reactions: many(commentReactions),
}));

export type Activity = typeof activity.$inferSelect;
export type NewActivity = typeof activity.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
