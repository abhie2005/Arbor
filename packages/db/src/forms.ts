/**
 * Forms: a door into one list that does not need a session.
 *
 * **What a submission acts as is the whole question, and it has been answered
 * twice already.** D-126 made an automation write as a per-workspace service
 * account; D-133 made an API token write as a named one per integration. A
 * public form is the same answer a third time, with "and anonymously" added:
 * each form owns a `users` row with `kind = 'service'`, a `guest` membership
 * and a grant on its container, so no permission code path learns a new
 * principal kind and the activity log can say which form wrote a task (D-142).
 *
 * `guest`, not `member`, for the reason D-133 gives: a `member`'s baseline is
 * `edit` on every container nobody marked private, so a form "on one list"
 * would quietly reach the workspace.
 *
 * **A submission is an `Operation[]`** (invariant 1), so it gets its activity
 * row and its inverse like every other write, and the task it creates is the
 * record of it — there is no submissions table to disagree with the tasks.
 */
import { randomUUID } from "node:crypto";

import {
  type FormDefinition,
  FormError,
  parseFormDefinition,
  parseSubmission,
} from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { grantAccess, revokeAccess } from "./access";
import { pool } from "./client";
import { type ConfigContext, ConfigError, inTransaction, logConfigChange, requireName } from "./config";
import { applyOperations } from "./mutations";
import { resolveStatusSetFor } from "./statuses";

type Connection = Pool | PoolClient;

/**
 * How many submissions a form takes in total before it stops.
 *
 * A public endpoint with no ceiling is a public endpoint somebody will fill
 * with rubbish. This is deliberately a blunt instrument and not rate limiting:
 * rate limiting needs state per client, which needs an identity, which is the
 * one thing a form does not have. A manager can reopen it.
 */
export const SUBMISSION_LIMIT = 500;

export interface FormRecord {
  id: string;
  workspaceId: string;
  containerId: string;
  principalId: string;
  name: string;
  intro: string | null;
  definition: FormDefinition | null;
  /** Why the definition would not parse, for a screen that must still show it. */
  problem: string | null;
  isOpen: boolean;
  submissionCount: number;
  createdAt: Date;
  createdByName: string | null;
}

interface FormRow {
  id: string;
  workspace_id: string;
  container_id: string;
  principal_id: string;
  name: string;
  intro: string | null;
  fields: unknown;
  is_open: boolean;
  submission_count: number;
  created_at: Date;
  created_by_name: string | null;
}

/**
 * Hands back the parse failure as text rather than dropping the row, for the
 * reason `loadAutomationsForContainers` does (D-129): a form that cannot be
 * read is the one somebody most needs to see, and invisible is unfixable.
 */
function toRecord(row: FormRow): FormRecord {
  let definition: FormDefinition | null = null;
  let problem: string | null = null;
  try {
    definition = parseFormDefinition({ fields: row.fields });
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    containerId: row.container_id,
    principalId: row.principal_id,
    name: row.name,
    intro: row.intro,
    definition,
    problem,
    isOpen: row.is_open,
    submissionCount: row.submission_count,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
  };
}

const SELECT = `
  SELECT f.id, f.workspace_id, f.container_id, f.principal_id, f.name, f.intro, f.fields,
         f.is_open, f.submission_count, f.created_at, u.name AS created_by_name
    FROM forms f
    LEFT JOIN users u ON u.id = f.created_by`;

export async function loadForm(
  formId: string,
  connection: Connection = pool(),
): Promise<FormRecord | null> {
  if (!/^[0-9a-f-]{36}$/i.test(formId)) return null;
  const result = await connection.query<FormRow>(`${SELECT} WHERE f.id = $1`, [formId]);
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function loadFormsForContainers(
  containerIds: readonly string[],
  connection: Connection = pool(),
): Promise<FormRecord[]> {
  if (containerIds.length === 0) return [];
  const result = await connection.query<FormRow>(
    `${SELECT} WHERE f.container_id = ANY($1::uuid[]) ORDER BY f.created_at`,
    [[...containerIds]],
  );
  return result.rows.map(toRecord);
}

export async function createForm(
  input: {
    workspaceId: string;
    containerId: string;
    name: string;
    intro?: string | null;
    fields: unknown;
  },
  context: ConfigContext,
): Promise<string> {
  const name = requireName(input.name, "form");

  let definition: FormDefinition;
  try {
    definition = parseFormDefinition({ fields: input.fields });
  } catch (error) {
    throw new ConfigError(error instanceof FormError ? error.message : String(error));
  }

  const id = await inTransaction(context, async (client) => {
    /**
     * The principal, keyed on a fresh uuid like a token's (D-133) rather than
     * on the workspace's id (D-126's wart): a workspace may have as many forms
     * as somebody makes, and each one should be its own name in the log.
     */
    const created = await client.query<{ id: string }>(
      `INSERT INTO users (email, name, kind) VALUES ($1, $2, 'service') RETURNING id`,
      [`form+${randomUUID()}@service.arbor.local`, name],
    );
    const principalId = created.rows[0]!.id;

    await client.query(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'guest')
       ON CONFLICT DO NOTHING`,
      [input.workspaceId, principalId],
    );

    const row = await client.query<{ id: string }>(
      `INSERT INTO forms (workspace_id, container_id, principal_id, name, intro, fields, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        input.workspaceId,
        input.containerId,
        principalId,
        name,
        input.intro?.trim() || null,
        JSON.stringify(definition.fields),
        context.actorId,
      ],
    );

    const formId = row.rows[0]!.id;

    await logConfigChange(client, {
      workspaceId: input.workspaceId,
      actorId: context.actorId,
      objectKind: "form",
      objectId: formId,
      verb: "form.created",
      newValue: { name },
    });

    return formId;
  });

  /**
   * The grant is afterwards and in its own transaction, exactly as a token's
   * is (D-133): it rebuilds the access index inside the transaction that
   * changed the grant (D-071). Failing here leaves a form whose principal
   * reaches nothing, which is a form that refuses submissions — the safe
   * direction. The reverse order would leave a list writable by a form nobody
   * finished making.
   */
  const form = await loadForm(id, context.connection ?? pool());
  await grantAccess(
    {
      containerId: input.containerId,
      principalKind: "user",
      principalId: form!.principalId,
      // `comment` would not be enough — a submission creates a task — and
      // `manage` would let a stranger's door re-share the list.
      permission: "edit",
    },
    context,
  );

  return id;
}

export async function setFormOpen(
  formId: string,
  isOpen: boolean,
  context: ConfigContext,
): Promise<void> {
  await inTransaction(context, async (client) => {
    const result = await client.query<{ workspace_id: string }>(
      `UPDATE forms SET is_open = $2, updated_at = now() WHERE id = $1 RETURNING workspace_id`,
      [formId, isOpen],
    );
    const row = result.rows[0];
    if (!row) throw new ConfigError("That form no longer exists");

    await logConfigChange(client, {
      workspaceId: row.workspace_id,
      actorId: context.actorId,
      objectKind: "form",
      objectId: formId,
      verb: isOpen ? "form.opened" : "form.closed",
      newValue: { isOpen },
    });
  });
}

export async function deleteForm(formId: string, context: ConfigContext): Promise<void> {
  const form = await loadForm(formId, context.connection ?? pool());
  if (!form) throw new ConfigError("That form no longer exists");

  await inTransaction(context, async (client) => {
    const result = await client.query<{ workspace_id: string; name: string }>(
      `DELETE FROM forms WHERE id = $1 RETURNING workspace_id, name`,
      [formId],
    );
    const row = result.rows[0];
    if (!row) throw new ConfigError("That form no longer exists");

    await logConfigChange(client, {
      workspaceId: row.workspace_id,
      actorId: context.actorId,
      objectKind: "form",
      objectId: formId,
      verb: "form.deleted",
      oldValue: { name: row.name },
    });
  });

  /**
   * **Revoked, not deleted.** `DELETE FROM grants` leaves `access_index`
   * holding rows nobody can explain — the trap CLAUDE.md names — so the door
   * would still be open to a principal whose form is gone. `revokeAccess`
   * rebuilds the index inside the transaction that changed the grant (D-071),
   * and runs in its own transaction for the same reason the grant in
   * `createForm` does.
   *
   * The principal itself stays. It wrote the tasks this form produced, and
   * `activity.actor_id` is `SET NULL`, so deleting it would rewrite "this came
   * in through the contact form" to "somebody did this" on every task it ever
   * created — the call D-139 made for the sweep, applied here.
   */
  await revokeAccess(form.containerId, "user", form.principalId, context);
}

export class SubmissionRefused extends Error {}

/**
 * Somebody with no session, writing to a list they cannot see.
 *
 * Everything that makes that safe is here or in `parseSubmission`: the form
 * must be open, under its limit, and the values must be exactly what it asked
 * for. The write itself is ordinary — `applyOperations` as the form's
 * principal, whose grant is `edit` on this container and nothing else — so a
 * submission cannot reach further than the door it came through.
 */
export async function submitForm(
  formId: string,
  body: unknown,
  connection: Pool = pool(),
): Promise<{ taskId: string }> {
  const form = await loadForm(formId, connection);
  if (!form) throw new SubmissionRefused("That form no longer exists");
  if (!form.isOpen) throw new SubmissionRefused("This form is closed");
  if (!form.definition) {
    // The same words as a closed one on purpose: a stranger learns that it is
    // not taking submissions, not that its definition is broken.
    throw new SubmissionRefused("This form is closed");
  }
  if (form.submissionCount >= SUBMISSION_LIMIT) {
    throw new SubmissionRefused("This form is not taking any more submissions");
  }

  let values: Record<string, unknown>;
  try {
    values = parseSubmission(form.definition, body);
  } catch (error) {
    throw new SubmissionRefused(error instanceof FormError ? error.message : String(error));
  }

  const space = await connection.query<{ space_id: string; folder_id: string | null }>(
    `SELECT COALESCE(sp.id, c.parent_id) AS space_id,
            CASE WHEN f.kind = 'folder' THEN f.id END AS folder_id
       FROM containers c
       LEFT JOIN containers f  ON f.id = c.parent_id AND f.kind = 'folder'
       LEFT JOIN containers sp ON sp.id = COALESCE(f.parent_id, c.parent_id) AND sp.kind = 'space'
      WHERE c.id = $1`,
    [form.containerId],
  );
  const place = space.rows[0];
  if (!place?.space_id) throw new SubmissionRefused("That form no longer exists");

  /**
   * The state a submission arrives in.
   *
   * `statusId` is not a field a form may ask for (D-142) — where a task lands
   * and what state it arrives in are the list manager's decisions, not a
   * stranger's — but "not asked" must not mean "not set". A task with a null
   * status renders in **no section at all** on the list screen, because the
   * renderer draws a group per status: the submission arrives, and nobody ever
   * sees it. Found by opening the page rather than by any check here.
   *
   * The list's own set, resolved through inheritance (D-014), and its first
   * status — which is what "the start of this list's workflow" means, and what
   * every other way of creating a task already gives you.
   */
  const resolved = await resolveStatusSetFor(form.workspaceId, form.containerId, connection);
  const statusId = resolved.set.statuses[0]?.id ?? null;

  const taskId = randomUUID();

  /**
   * Two kinds of operation, because `createTask` does not carry every column.
   *
   * Its INSERT takes `name`, `status_id`, `priority` and the placement, and
   * everything else on a task is a `setField` — which is why a form that asked
   * for a due date silently dropped it until a check said so. One batch, so it
   * is one transaction and one activity group: a submission is one event.
   */
  const CREATE_CARRIES = new Set(["name", "priority"]);
  const carried = Object.fromEntries(
    Object.entries(values).filter(([field]) => CREATE_CARRIES.has(field)),
  );

  await applyOperations(
    [
      {
        kind: "createTask",
        taskId,
        listId: form.containerId,
        values: {
          ...carried,
          statusId,
          spaceId: place.space_id,
          folderId: place.folder_id,
          position: "a0",
        },
      },
      ...Object.entries(values)
        .filter(([field]) => !CREATE_CARRIES.has(field))
        .map(([field, value]) => ({
          kind: "setField" as const,
          taskId,
          field: field as "dueAt" | "startAt" | "points",
          from: null,
          to: value,
        })),
    ],
    { actorId: form.principalId, connection },
  );

  // Outside the operation, deliberately: the counter is a property of the
  // form rather than of the task, and a submission that created a task but
  // failed to increment is a better failure than the reverse.
  await connection.query(
    `UPDATE forms SET submission_count = submission_count + 1, updated_at = now() WHERE id = $1`,
    [formId],
  );

  return { taskId };
}
