import { pgEnum } from "drizzle-orm/pg-core";

/**
 * One polymorphic container tree instead of separate space/folder/list tables.
 * Nesting depth is unconstrained, so "subfolders" are not a special case.
 */
export const containerKind = pgEnum("container_kind", ["space", "folder", "list"]);

/**
 * Statuses are user-defined strings, but every status belongs to a fixed group.
 * Reporting, filters, and "is this finished" always key off the group, never the name.
 */
export const statusGroup = pgEnum("status_group", ["not_started", "active", "done", "closed"]);

export const fieldType = pgEnum("field_type", [
  "short_text",
  "text",
  "number",
  "currency",
  "checkbox",
  "date",
  "drop_down",
  "labels",
  "url",
  "email",
  "phone",
  "users",
  "tasks",
  "location",
  "rating",
  "manual_progress",
  "automatic_progress",
  "formula",
  "relationship",
  "rollup",
]);

export const viewType = pgEnum("view_type", [
  "list",
  "board",
  "table",
  "calendar",
  "gantt",
  "timeline",
  "workload",
  "map",
  "activity",
  "form",
  "doc",
]);

export const memberRole = pgEnum("member_role", [
  "owner",
  "admin",
  "member",
  "limited_member",
  "guest",
]);

export const principalKind = pgEnum("principal_kind", ["user", "group"]);

/** Ordered by privilege: view < comment < edit < manage. */
export const permission = pgEnum("permission", ["view", "comment", "edit", "manage"]);

export const taskLinkKind = pgEnum("task_link_kind", ["blocks", "waits_on", "relates"]);

/**
 * What an activity row is about. Configuration objects are in here alongside
 * tasks on purpose: "who deleted the Done status, and when" is a question the
 * activity log has to be able to answer, and a change nobody can attribute is
 * exactly the kind that erodes trust in a shared workspace.
 */
export const objectKind = pgEnum("object_kind", [
  "workspace",
  "container",
  "task",
  "view",
  "doc",
  "comment",
  "field",
  "status",
  "status_set",
  "task_type",
]);
