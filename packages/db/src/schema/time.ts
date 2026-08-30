import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { containers } from "./containers";
import { tasks } from "./tasks";
import { users, workspaces } from "./workspaces";

/**
 * A running entry is one with `endedAt` null. Enforce at most one per user in
 * the service layer — starting a second timer stops the first.
 */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Denormalized on stop so timesheet sums never subtract timestamps. */
    durationMs: bigint("duration_ms", { mode: "number" }),
    description: text("description"),
    isBillable: boolean("is_billable").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("time_entries_user_idx").on(t.userId, t.startedAt),
    index("time_entries_task_idx").on(t.taskId),
    index("time_entries_running_idx").on(t.userId, t.endedAt),
  ],
);

/** Per-assignee estimate splits, so a shared task can be planned per person. */
export const taskEstimates = pgTable(
  "task_estimates",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    estimateMs: bigint("estimate_ms", { mode: "number" }).notNull(),
  },
  (t) => [index("task_estimates_task_idx").on(t.taskId)],
);

export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("goals_workspace_idx").on(t.workspaceId, t.archivedAt)],
);

/**
 * Key results. `kind` picks which target applies: number, currency, boolean,
 * or a task/list rollup whose progress is derived rather than entered.
 */
export const keyResults = pgTable(
  "key_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    startValue: text("start_value"),
    targetValue: text("target_value"),
    currentValue: text("current_value"),
    /** For task/list rollups: which lists or tasks feed the number. */
    source: jsonb("source").$type<Record<string, unknown>>().notNull().default({}),
    position: text("position").notNull(),
  },
  (t) => [index("key_results_goal_idx").on(t.goalId, t.position)],
);

export const timeEntriesRelations = relations(timeEntries, ({ one }) => ({
  task: one(tasks, { fields: [timeEntries.taskId], references: [tasks.id] }),
  user: one(users, { fields: [timeEntries.userId], references: [users.id] }),
}));

export const goalsRelations = relations(goals, ({ many }) => ({
  keyResults: many(keyResults),
}));

/** Sprint folders and dashboards attach here later; both are containers + config. */
export const dashboards = pgTable(
  "dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    containerId: uuid("container_id").references(() => containers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Grid of cards; each card is a saved query plus a chart spec. */
    layout: jsonb("layout").$type<unknown>().notNull().default([]),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dashboards_workspace_idx").on(t.workspaceId)],
);

export type TimeEntry = typeof timeEntries.$inferSelect;
export type Goal = typeof goals.$inferSelect;
export type KeyResult = typeof keyResults.$inferSelect;
export type Dashboard = typeof dashboards.$inferSelect;
