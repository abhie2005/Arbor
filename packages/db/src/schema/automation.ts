import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { docLinkTarget } from "./enums";
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
    /**
     * How long to wait before acting, in seconds (D-128).
     *
     * Zero means immediately, which is what every rule did before this column
     * existed. A delayed run is a row with `run_after` in the future, and its
     * conditions are evaluated when it *runs* rather than when it was queued —
     * which is the whole point: "in 3 days, if still open" is a question about
     * the task in three days' time.
     */
    delaySeconds: integer("delay_seconds").notNull().default(0),
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
    /**
     * "pending" | "success" | "failed" | "skipped_conditions" | "skipped_self"
     * | "refused_depth" | "refused_quota"
     *
     * **`pending` is why this table is also the queue** (D-125). A run that has
     * not happened yet is still an execution, so giving it a second table would
     * mean two rows per run and a moment where one exists and the other does
     * not. The unique index on `idempotencyKey` is then exactly what makes an
     * overlapping activity scan harmless.
     */
    status: text("status").notNull(),
    error: text("error"),
    /** When this becomes due. Now for an immediate rule, later for a delay. */
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    /** Set by the claim, so a second replica skips it. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("automation_runs_idempotency_key").on(t.idempotencyKey),
    index("automation_runs_quota_idx").on(t.workspaceId, t.startedAt),
    index("automation_runs_automation_idx").on(t.automationId, t.startedAt),
  ],
);

/**
 * How far the activity scan has read, per workspace.
 *
 * **A watermark with deliberate slack** (D-125). Activity ids come from a
 * sequence, and a transaction that took a lower id can commit after one that
 * took a higher id — so a strict "last id seen" silently skips whatever was
 * still in flight at the moment of the read. The scan therefore re-reads a
 * short overlap every time and lets the unique index on
 * `automation_runs.idempotency_key` refuse the duplicate, which is the trade
 * the Phase 1 schema already chose by putting that index there.
 */
export const automationCursors = pgTable("automation_cursors", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  lastActivityId: bigint("last_activity_id", { mode: "bigint" }).notNull().default(0n),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
 * Postgres `bytea`, which drizzle has no built-in for.
 *
 * `Buffer` in both directions: `pg` hands back a Buffer and accepts one, and a
 * `Uint8Array` view over it is free — so callers work in the type Yjs speaks
 * without a copy.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * A Yjs update holding one document's whole state.
 *
 * Structured records are server-authoritative and do not belong here; only
 * genuinely concurrent character-level editing needs a CRDT (ADR 4). What the
 * update *contains* is the block tree `richtext.ts` describes, in Yjs types —
 * ADR 6, and the reason `search_text` beside it is a projection rather than a
 * second copy of the prose.
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
    /**
     * The merged Yjs update, as bytes.
     *
     * `bytea` rather than `text` (D-111): a Yjs update is binary, and base64 in
     * a text column costs a third more space plus an encode and a decode on
     * every read of something that is only ever handed to a merge.
     */
    ydoc: bytea("ydoc"),
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
    /**
     * Trigram GIN, because search matches with `ILIKE '%term%'` (D-113) and a
     * leading wildcard gives a btree no prefix to descend on. These are the two
     * columns `searchDocs` tests, and they are the reason the ILIKE decision is
     * affordable rather than only simple.
     */
    index("docs_search_text_trgm_idx").using("gin", sql`${t.searchText} gin_trgm_ops`),
    index("docs_title_trgm_idx").using("gin", sql`${t.title} gin_trgm_ops`),
  ],
);

/**
 * What a document points at (D-120).
 *
 * **An edge table maintained on write, which is the same bet `search_text`
 * makes.** Answering "what links here" from the documents themselves would
 * mean loading and parsing every CRDT in the workspace to render one footer;
 * the links are therefore recomputed from the projection whenever a document
 * is written, exactly where `search_text` already is.
 *
 * **The target is a kind plus an id, with no foreign key.** A page and a task
 * live in different tables, so a single `references()` cannot express it — and
 * a pair of nullable columns with a check constraint would be two columns that
 * can both be null. The cost is that a deleted target leaves a row behind,
 * which is why every read joins to the real table and drops what no longer
 * resolves: the edge is a record of what the document said, and the join is
 * what decides whether it still means anything.
 *
 * `task_links` is the same shape for tasks pointing at tasks, down to the
 * reverse index being the whole point.
 */
export const docLinks = pgTable(
  "doc_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceDocId: uuid("source_doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    targetKind: docLinkTarget("target_kind").notNull(),
    targetId: uuid("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One edge per source and target: a page linked twice from one document is
    // still one thing pointing at another.
    uniqueIndex("doc_links_unique").on(t.sourceDocId, t.targetKind, t.targetId),
    // The reverse lookup, which is the entire reason this table exists.
    index("doc_links_target_idx").on(t.targetKind, t.targetId),
  ],
);

export type DocLink = typeof docLinks.$inferSelect;

export type Automation = typeof automations.$inferSelect;
export type AutomationCursor = typeof automationCursors.$inferSelect;
export type AutomationRun = typeof automationRuns.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type Doc = typeof docs.$inferSelect;
