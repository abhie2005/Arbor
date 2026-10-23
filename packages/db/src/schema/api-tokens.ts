import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { containers } from "./containers";
import { users, workspaces } from "./workspaces";

/**
 * A token that is not a session.
 *
 * **It acts as a named service account, one per integration** (D-133). D-126
 * settled what an automation authenticates as and left the API's half open:
 * the answer is the same answer, which is why no permission code path is added
 * here. A token names a `users` row with `kind = 'service'` — "the nightly
 * importer", "Zapier" — holding its own membership and its own grants, so the
 * activity log can say which integration wrote a thing and one of them can be
 * granted less than another.
 *
 * Rejected: one token principal per workspace, which makes every integration
 * the same actor and every grant all-or-nothing; and a token that acts as the
 * person who minted it, which writes a person's name on a script's work and
 * outlives the intent it was made for.
 *
 * **Stored as a hash, like a session** (`tokenHash`): the token is shown once,
 * at creation, and is unrecoverable afterwards. `prefix` is the readable head
 * of it, so a list can name a token without holding one.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The service account this token speaks as. Permissions are its grants. */
    principalId: uuid("principal_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** What it is for, in a person's words. Shown in settings and in history. */
    name: text("name").notNull(),
    /**
     * The container it was minted against (D-133).
     *
     * Not where its permissions live — those are `grants` like anybody's, and
     * may be widened or narrowed afterwards from the sharing screen. This is
     * the scope it was *created* with, which is what a settings list shows and
     * what a revocation is a sentence about. Cascades: a token minted against a
     * container that no longer exists was for work that no longer exists, and
     * its grant went with the container regardless.
     */
    containerId: uuid("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /** The first characters of the token, for recognising it in a list. */
    prefix: text("prefix").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Written on use, so an unused token can be told from a working one. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Null means it does not expire. A revoked token is dead regardless. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("api_tokens_token_key").on(t.tokenHash),
    index("api_tokens_workspace_idx").on(t.workspaceId),
    index("api_tokens_principal_idx").on(t.principalId),
  ],
);
