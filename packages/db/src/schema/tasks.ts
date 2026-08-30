import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { containers } from "./containers";
import { taskLinkKind } from "./enums";
import { statuses } from "./statuses";
import { tags, users, workspaces } from "./workspaces";

/** Bug, Feature, Lead… Drives which custom fields render on a task. */
export const taskTypes = pgTable(
  "task_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon"),
    isDefault: boolean("is_default").notNull().default(false),
  },
  (t) => [uniqueIndex("task_types_name_key").on(t.workspaceId, t.name)],
);

/**
 * Tasks and subtasks are the same row — a subtask is just a task with a parent.
 * Splitting them would mean building every feature twice.
 *
 * `spaceId` and `folderId` are denormalized ancestors, maintained on move. They
 * turn cross-container views from a recursive CTE into an index scan, which is
 * the difference between a view that opens instantly and one that doesn't.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

    /** Status and custom fields always resolve against the home list. */
    homeListId: uuid("home_list_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
    parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => tasks.id, {
      onDelete: "cascade",
    }),

    /** Denormalized ancestry — never the source of truth, always kept in sync on move. */
    spaceId: uuid("space_id").notNull(),
    folderId: uuid("folder_id"),

    /** Human-readable key, e.g. ENG-402. Prefix from the space, counter per workspace. */
    key: text("key"),
    name: text("name").notNull(),
    /** Yjs document holding the rich-text description. Same editor as Docs. */
    descriptionDocId: uuid("description_doc_id"),

    statusId: uuid("status_id").references(() => statuses.id, { onDelete: "set null" }),
    taskTypeId: uuid("task_type_id").references(() => taskTypes.id, { onDelete: "set null" }),
    /** 1 urgent · 2 high · 3 normal · 4 low · null none. A fixed scale, unlike status. */
    priority: integer("priority"),

    startAt: timestamp("start_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    /**
     * False means the date is a calendar day, not an instant. Without this a
     * date-only due date silently shifts a day across timezones.
     */
    startHasTime: boolean("start_has_time").notNull().default(false),
    dueHasTime: boolean("due_has_time").notNull().default(false),

    timeEstimateMs: bigint("time_estimate_ms", { mode: "number" }),
    points: numeric("points"),
    position: text("position").notNull(),

    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Soft delete everywhere. Restore is table stakes in this category. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("tasks_key_unique").on(t.workspaceId, t.key),
    index("tasks_home_list_idx").on(t.homeListId, t.position),
    index("tasks_space_idx").on(t.spaceId, t.archivedAt),
    index("tasks_folder_idx").on(t.folderId),
    index("tasks_parent_idx").on(t.parentTaskId),
    index("tasks_status_idx").on(t.statusId),
    index("tasks_due_idx").on(t.workspaceId, t.dueAt),
    index("tasks_updated_idx").on(t.workspaceId, t.updatedAt),
  ],
);

/**
 * A task can appear in several lists at once. This join table is why
 * `tasks.homeListId` alone is not enough — and why it has to exist from the
 * first migration. Retrofitting it means rewriting every task query in the app.
 */
export const taskLists = pgTable(
  "task_lists",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    listId: uuid("list_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
    isHome: boolean("is_home").notNull().default(false),
    position: text("position").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.listId] }),
    index("task_lists_list_idx").on(t.listId, t.position),
  ],
);

export const taskAssignees = pgTable(
  "task_assignees",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.userId] }),
    index("task_assignees_user_idx").on(t.userId),
  ],
);

/** Drives notification fan-out. Deliberately separate from assignees. */
export const taskWatchers = pgTable(
  "task_watchers",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.userId] }),
    index("task_watchers_user_idx").on(t.userId),
  ],
);

export const taskTags = pgTable(
  "task_tags",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tagId] })],
);

/**
 * Dependencies and plain links in one edge table. `blocks` and `waits_on` carry
 * scheduling meaning (Gantt, "can't close until"); `relates` is decorative.
 */
export const taskLinks = pgTable(
  "task_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    linkedTaskId: uuid("linked_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: taskLinkKind("kind").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("task_links_unique").on(t.taskId, t.linkedTaskId, t.kind),
    index("task_links_linked_idx").on(t.linkedTaskId),
  ],
);

/** Deliberately cheap: no status, no assignee semantics, no reporting. */
export const checklists = pgTable(
  "checklists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: text("position").notNull(),
  },
  (t) => [index("checklists_task_idx").on(t.taskId, t.position)],
);

export const checklistItems = pgTable(
  "checklist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    checklistId: uuid("checklist_id")
      .notNull()
      .references(() => checklists.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isChecked: boolean("is_checked").notNull().default(false),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    position: text("position").notNull(),
  },
  (t) => [index("checklist_items_parent_idx").on(t.checklistId, t.position)],
);

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    /** Object key in S3-compatible storage. Never a full URL — the host varies. */
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("attachments_task_idx").on(t.taskId)],
);

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  homeList: one(containers, {
    fields: [tasks.homeListId],
    references: [containers.id],
  }),
  parent: one(tasks, {
    fields: [tasks.parentTaskId],
    references: [tasks.id],
    relationName: "task_tree",
  }),
  subtasks: many(tasks, { relationName: "task_tree" }),
  status: one(statuses, { fields: [tasks.statusId], references: [statuses.id] }),
  taskType: one(taskTypes, { fields: [tasks.taskTypeId], references: [taskTypes.id] }),
  assignees: many(taskAssignees),
  watchers: many(taskWatchers),
  lists: many(taskLists),
  checklists: many(checklists),
  attachments: many(attachments),
}));

export const taskAssigneesRelations = relations(taskAssignees, ({ one }) => ({
  task: one(tasks, { fields: [taskAssignees.taskId], references: [tasks.id] }),
  user: one(users, { fields: [taskAssignees.userId], references: [users.id] }),
}));

export const taskListsRelations = relations(taskLists, ({ one }) => ({
  task: one(tasks, { fields: [taskLists.taskId], references: [tasks.id] }),
  list: one(containers, {
    fields: [taskLists.listId],
    references: [containers.id],
  }),
}));

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskType = typeof taskTypes.$inferSelect;
export type Checklist = typeof checklists.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
