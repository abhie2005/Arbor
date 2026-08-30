import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { containers } from "./containers";
import { users, workspaces } from "./workspaces";

/**
 * trigger → conditions[] → actions[], scoped to a container.
 *
 * The rule shape is the easy part. The hard parts are encoded in `automationRuns`
 * below: loop prevention, idempotency, and run quotas.
 */
export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    containerId: uuid("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull(),
    conditions: jsonb("conditions").$type<unknown[]>().notNull().default([]),
    actions: jsonb("actions").$type<unknown[]>().notNull().default([]),
    /** "tasks" | "subtasks" | "both" */
    appliesTo: text("applies_to").notNull().default("tasks"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("automations_container_idx").on(t.containerId, t.isEnabled)],
);

/**
 * Every execution, recorded.
 *
 * - `idempotencyKey` makes a queue retry a no-op instead of a duplicate subtask.
 * - `depth` is the loop guard: automation A fires B fires A. Runs above a small
 *   depth are refused and recorded as such, rather than silently dropped.
 * - Row count per workspace per month is the quota, and the pricing lever.
 *   Count from day one even if you never charge for it.
 */
export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    triggeredByActivityId: bigint("triggered_by_activity_id", { mode: "bigint" }),
    idempotencyKey: text("idempotency_key").notNull(),
    depth: integer("depth").notNull().default(0),
    /** "success" | "failed" | "skipped_conditions" | "refused_depth" | "refused_quota" */
    status: text("status").notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("automation_runs_idempotency_key").on(t.idempotencyKey),
    index("automation_runs_quota_idx").on(t.workspaceId, t.startedAt),
    index("automation_runs_automation_idx").on(t.automationId, t.startedAt),
  ],
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    /** Used to sign every delivery so receivers can verify origin. */
    secret: text("secret").notNull(),
    events: jsonb("events").$type<string[]>().notNull().default([]),
    containerId: uuid("container_id").references(() => containers.id, { onDelete: "cascade" }),
    isEnabled: boolean("is_enabled").notNull().default(true),
    failCount: integer("fail_count").notNull().default(0),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhooks_workspace_idx").on(t.workspaceId, t.isEnabled)],
);

/** Serialized subtree of a container plus its config, re-instantiable with date offsets. */
export const templates = pgTable(
  "templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** "task" | "list" | "folder" | "space" */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("templates_workspace_idx").on(t.workspaceId, t.kind)],
);

/**
 * Yjs document state for descriptions, docs, and whiteboards.
 *
 * Structured records are server-authoritative and do not belong here; only
 * genuinely concurrent character-level editing needs a CRDT.
 */
export const docs = pgTable(
  "docs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    containerId: uuid("container_id").references(() => containers.id, { onDelete: "cascade" }),
    parentPageId: uuid("parent_page_id"),
    title: text("title").notNull().default("Untitled"),
    /** Binary Yjs state vector + updates. */
    ydoc: text("ydoc"),
    /** Plain-text projection, maintained on save, for full-text search. */
    searchText: text("search_text"),
    position: text("position").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("docs_container_idx").on(t.containerId, t.position),
    index("docs_parent_idx").on(t.parentPageId),
  ],
);

export type Automation = typeof automations.$inferSelect;
export type AutomationRun = typeof automationRuns.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type Doc = typeof docs.$inferSelect;
