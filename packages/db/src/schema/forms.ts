import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { containers } from "./containers";
import { users, workspaces } from "./workspaces";

/**
 * A door into one list that does not need a session.
 *
 * **It acts as a service account of its own** (D-142) — the third time the same
 * question is answered the same way. D-126 settled what an automation writes
 * as, D-133 what an API token writes as, and a public form is both of those
 * with "and anonymously" added: a `users` row with `kind = 'service'`, a
 * `guest` membership and a grant on the form's container. No permission code
 * path is added, and the activity log can say which form wrote a task.
 *
 * Rejected: writing as the person who *made* the form, which puts a manager's
 * name on a stranger's words and keeps doing so after they leave; and a
 * nullable actor, which is the one thing an activity log must never contain —
 * a row that looks trustworthy and names nobody (the reason `requireUser`
 * throws).
 *
 * **`fields` bounds the submission as well as describing it.** A public writer
 * fills the fields a manager declared and nothing else; anything else arriving
 * in the body is refused rather than ignored, because an unauthenticated write
 * to an undeclared column is the obvious way this feature goes wrong.
 */
export const forms = pgTable(
  "forms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The list a submission lands in. A form is scoped like an automation. */
    containerId: uuid("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
    /** What a submission acts as. See above. */
    principalId: uuid("principal_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Plain text, not a block tree: a form's own prose is not a document. */
    intro: text("intro"),
    fields: jsonb("fields").$type<unknown>().notNull().default([]),
    /**
     * Closing a form is not deleting it. The tasks it produced stay, and so
     * does the record of where they came from.
     */
    isOpen: boolean("is_open").notNull().default(true),
    /**
     * A counter rather than a `COUNT(*)`: it is the quota's number, and it has
     * to survive the tasks being archived or deleted.
     */
    submissionCount: integer("submission_count").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("forms_container_idx").on(t.containerId),
    index("forms_workspace_idx").on(t.workspaceId),
    index("forms_principal_idx").on(t.principalId),
  ],
);

export type Form = typeof forms.$inferSelect;
