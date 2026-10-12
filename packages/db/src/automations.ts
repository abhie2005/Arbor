import { randomUUID } from "node:crypto";

import {
  type AutomationEvent,
  type AutomationRule,
  type TaskSnapshot,
  AutomationError,
  compileActions,
  compileViewQuery,
  idempotencyKeyFor,
  matches,
  parseAutomationRule,
  runVerdict,
  verbFor,
} from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";
import { type ConfigContext, ConfigError, inTransaction, logConfigChange, requireName } from "./config";
import { applyOperations } from "./mutations";

/**
 * Running an automation.
 *
 * The pure half — what a rule is, what fires it, what it compiles to — is
 * `packages/core/src/automations.ts` (D-124). This is the half that touches
 * Postgres, and it is three steps that are deliberately separable:
 *
 * 1. **scan** reads the activity log forward and writes a `pending` run for
 *    every rule an event matched. Cheap, idempotent, and the only thing that
 *    reads activity.
 * 2. **claim** takes due pending runs with `FOR UPDATE SKIP LOCKED`.
 * 3. **execute** evaluates conditions, compiles actions, and applies them.
 *
 * **The queue is a table, which is the whole decision** (D-125). Every
 * transport question in this system so far has been answered by Postgres —
 * changes (D-090), presence (D-092, D-100), document updates (D-112) — and a
 * delayed automation is the first thing that genuinely cannot be answered by a
 * connection somebody is holding open. It is still answered by Postgres: a run
 * due in three days is a row with `run_after` three days out. Nothing here
 * knows or cares which process drains it, so "lift this into a worker service"
 * is later a deployment decision rather than a rewrite, and the app still reads
 * exactly three environment variables (invariant 14).
 *
 * **Two replicas are the default** (`desired_count = 2`), so the claim is not a
 * precaution — a scheduler that assumed one process would double every run in
 * production on day one.
 */

type Connection = Pool | PoolClient;

/** How many runs a workspace may make in a calendar month. */
export const MONTHLY_RUN_QUOTA = 1000;

/** How far back the scan re-reads. See `automationCursors` on why there is slack. */
const SCAN_OVERLAP = 50n;

/** How many runs one drain takes, so a burst cannot monopolise a tick. */
const CLAIM_BATCH = 25;

export interface AutomationRecord {
  id: string;
  workspaceId: string;
  containerId: string;
  name: string;
  rule: AutomationRule;
  isEnabled: boolean;
  /** A rule is not retroactive. See the note in `scanForAutomations`. */
  createdAt: Date;
}

/**
 * The account an automation acts as (D-126).
 *
 * **A real user row, created once per workspace.** Every read in this system
 * joins `access_index` for a principal, and `applyOperations` refuses an empty
 * actor because a log with a null author still looks trustworthy. A service
 * account satisfies both without touching either: it is a member like anybody
 * else, it appears in the index through the ordinary rebuild, and history can
 * name it.
 *
 * The email is synthetic because the column is unique and not null. That is the
 * one piece of grit in this decision, and it is preferable to making email
 * nullable for every row in the table to accommodate a handful that never sign
 * in.
 */
export async function ensureAutomationActor(
  workspaceId: string,
  connection: Connection = pool(),
): Promise<string> {
  const email = `automation+${workspaceId}@service.arbor.local`;

  const existing = await connection.query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1`,
    [email],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const created = await connection.query<{ id: string }>(
    `INSERT INTO users (email, name, kind) VALUES ($1, 'Automation', 'service')
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [email],
  );
  const actorId = created.rows[0]!.id;

  // A member, because a principal with no membership is dropped by
  // `resolveAccess` — a grant to a non-member is inert by design.
  await connection.query(
    `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')
     ON CONFLICT DO NOTHING`,
    [workspaceId, actorId],
  );

  return actorId;
}

/** Every enabled rule in a workspace, parsed and ready to match. */
export async function loadAutomations(
  workspaceId: string,
  connection: Connection = pool(),
): Promise<AutomationRecord[]> {
  const result = await connection.query<{
    id: string;
    workspace_id: string;
    container_id: string;
    name: string;
    trigger: unknown;
    conditions: unknown;
    actions: unknown;
    applies_to: string;
    is_enabled: boolean;
    created_at: Date;
  }>(
    `SELECT id, workspace_id, container_id, name, trigger, conditions, actions, applies_to,
            is_enabled, created_at
     FROM automations WHERE workspace_id = $1 AND is_enabled = true`,
    [workspaceId],
  );

  const records: AutomationRecord[] = [];
  for (const row of result.rows) {
    try {
      records.push({
        id: row.id,
        workspaceId: row.workspace_id,
        containerId: row.container_id,
        name: row.name,
        isEnabled: row.is_enabled,
        createdAt: row.created_at,
        rule: parseAutomationRule({
          trigger: row.trigger,
          conditions: row.conditions,
          actions: row.actions,
          appliesTo: row.applies_to,
        }),
      });
    } catch {
      // A rule that no longer parses is skipped rather than fatal: one bad row
      // must not stop every other automation in the workspace. It cannot have
      // been written through `createAutomation`, which validates first.
      continue;
    }
  }
  return records;
}

interface ActivityRow {
  id: string;
  at: Date;
  verb: string;
  object_id: string;
  actor_id: string | null;
  old_value: unknown;
  new_value: unknown;
  list_id: string | null;
  parent_task_id: string | null;
  home_list_id: string | null;
  folder_id: string | null;
  space_id: string | null;
  cause_automation_id: string | null;
  cause_depth: number | null;
}

/**
 * Reads the log forward and enqueues what matched.
 *
 * The overlap is the point: a strict watermark would skip rows that were still
 * in flight when the last scan read the maximum id. Re-reading and letting the
 * unique index refuse the duplicate costs one failed insert and is correct
 * without a snapshot-tracking scheme nobody would be able to debug.
 */
export async function scanForAutomations(
  workspaceId: string,
  connection: Connection = pool(),
): Promise<{ scanned: number; enqueued: number }> {
  const rules = await loadAutomations(workspaceId, connection);
  if (rules.length === 0) return { scanned: 0, enqueued: 0 };

  // **A cursor that has never existed starts at the end of the log, not at the
  // beginning.** Starting at zero means a workspace that enables its first
  // automation crawls its entire history 500 rows at a time before it reaches
  // anything current — minutes of ticks during which the engine looks broken,
  // all of it to consider rows no rule may act on anyway. Beginning at `now`
  // makes a cold start immediate, and makes "a rule is not retroactive" true of
  // the very first scan rather than only of the filter below.
  const cursor = await connection.query<{ last_activity_id: string }>(
    `INSERT INTO automation_cursors (workspace_id, last_activity_id)
     VALUES ($1, (SELECT COALESCE(max(id), 0) FROM activity WHERE workspace_id = $1))
     ON CONFLICT (workspace_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
     RETURNING last_activity_id`,
    [workspaceId],
  );
  const last = BigInt(cursor.rows[0]?.last_activity_id ?? "0");
  const from = last > SCAN_OVERLAP ? last - SCAN_OVERLAP : 0n;

  // The join to tasks supplies `parent_task_id`, which `appliesTo` needs and
  // the log has no column for; the join to automation_runs supplies the depth
  // of whatever produced this row, which is how a cascade counts itself.
  const events = await connection.query<ActivityRow>(
    `SELECT a.id, a.at, a.verb, a.object_id, a.actor_id, a.old_value, a.new_value, a.list_id,
            t.parent_task_id, t.home_list_id, t.folder_id, t.space_id,
            r.automation_id AS cause_automation_id,
            r.depth         AS cause_depth
     FROM activity a
     LEFT JOIN tasks t ON t.id = a.object_id
     LEFT JOIN automation_runs r ON r.id = a.automation_run_id
     WHERE a.workspace_id = $1 AND a.id > $2 AND a.object_kind = 'task'
     ORDER BY a.id
     LIMIT 500`,
    [workspaceId, from.toString()],
  );

  let enqueued = 0;
  let highest = last;

  for (const row of events.rows) {
    const id = BigInt(row.id);
    if (id > highest) highest = id;

    const event: AutomationEvent = {
      activityId: row.id,
      verb: row.verb,
      from: row.old_value,
      to: row.new_value,
      taskId: row.object_id,
      actorId: row.actor_id ?? "",
      isSubtask: row.parent_task_id !== null,
      causedBy: row.cause_automation_id
        ? { automationId: row.cause_automation_id, depth: row.cause_depth ?? 0 }
        : undefined,
    };

    for (const rule of rules) {
      if (!appliesHere(rule, row)) continue;
      if (!matches(rule.rule, event)) continue;
      if (await enqueue(rule, event, connection)) enqueued += 1;
    }
  }

  await connection.query(
    `UPDATE automation_cursors SET last_activity_id = $2, updated_at = now() WHERE workspace_id = $1`,
    [workspaceId, highest.toString()],
  );

  return { scanned: events.rows.length, enqueued };
}

/**
 * Writes the pending run, or finds it already written.
 *
 * The verdict is decided here rather than at execution time so a refusal is
 * recorded once, with a reason, instead of being retried every tick. A refused
 * run is a finished row the moment it is written.
 */
async function enqueue(
  rule: AutomationRecord,
  event: AutomationEvent,
  connection: Connection,
): Promise<boolean> {
  const used = await runsThisMonth(rule.workspaceId, connection);
  const verdict = runVerdict({
    automationId: rule.id,
    event,
    runsThisPeriod: used,
    quota: MONTHLY_RUN_QUOTA,
  });

  const key = idempotencyKeyFor(rule.id, event.activityId);
  const depth = (event.causedBy?.depth ?? -1) + 1;
  const settled = verdict !== "run";

  const result = await connection.query(
    `INSERT INTO automation_runs
       (workspace_id, automation_id, triggered_by_activity_id, idempotency_key, depth, status,
        run_after, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      rule.workspaceId,
      rule.id,
      event.activityId,
      key,
      depth,
      settled ? verdict : "pending",
      settled ? new Date().toISOString() : null,
    ],
  );

  return (result.rowCount ?? 0) > 0 && !settled;
}

/**
 * Is this event in this rule's scope, and new enough for it to be about?
 *
 * **Two filters the scan cannot express in SQL**, because they are per rule and
 * the query reads the log once for all of them.
 *
 * **A rule is not retroactive**, which the overlap made untrue and a real server
 * caught. The scan deliberately re-reads rows behind the cursor (see
 * `automationCursors`), and the idempotency key only dedupes a rule against
 * activity *it has already been offered*. A rule created a moment ago has been
 * offered none — so the overlap handed it fifty rows of history and it fired on
 * all of them. Found by arming one rule, making one change, and getting three
 * runs: two of them were a task's transitions from the previous test run.
 * Comparing against `created_at` is what makes "enabling an automation does not
 * replay the log" true rather than merely intended.
 *
 * **A rule only sees its own container's subtree.** A task carries its space,
 * folder and list, so a rule on a space covers every list inside it and a rule
 * on a list covers exactly that list. Without this, a rule somebody created on
 * one list fires for every task in the workspace — which is both wrong and
 * wider than the `manage` grant that allowed the rule to be written.
 */
function appliesHere(rule: AutomationRecord, row: ActivityRow): boolean {
  if (row.at && row.at < rule.createdAt) return false;

  return (
    rule.containerId === row.home_list_id ||
    rule.containerId === row.folder_id ||
    rule.containerId === row.space_id
  );
}

async function runsThisMonth(workspaceId: string, connection: Connection): Promise<number> {
  const result = await connection.query<{ count: string }>(
    `SELECT count(*) AS count FROM automation_runs
     WHERE workspace_id = $1 AND started_at >= date_trunc('month', now())`,
    [workspaceId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export interface ClaimedRun {
  id: string;
  workspaceId: string;
  automationId: string;
  taskId: string;
  depth: number;
}

/**
 * Takes due work, leaving anything another process already holds.
 *
 * `SKIP LOCKED` rather than a lease column with a timestamp: the lock is held
 * by the transaction, so a replica that dies mid-claim releases its rows when
 * its connection drops, instead of leaving them stranded until a reaper that
 * nobody wrote comes to find them.
 */
export async function claimDueRuns(
  connection: Connection = pool(),
  limit = CLAIM_BATCH,
): Promise<ClaimedRun[]> {
  const result = await connection.query<{
    id: string;
    workspace_id: string;
    automation_id: string;
    object_id: string;
    depth: number;
  }>(
    `WITH due AS (
       SELECT r.id FROM automation_runs r
       WHERE r.status = 'pending' AND r.run_after <= now()
       ORDER BY r.run_after
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE automation_runs r
        SET status = 'running', claimed_at = now(), attempts = r.attempts + 1
       FROM due, activity a
      WHERE r.id = due.id AND a.id = r.triggered_by_activity_id
      RETURNING r.id, r.workspace_id, r.automation_id, a.object_id, r.depth`,
    [limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    automationId: row.automation_id,
    taskId: row.object_id,
    depth: row.depth,
  }));
}

/**
 * The task as `compileActions` needs to see it.
 *
 * Read by hand rather than through the compiler, because this is one task by id
 * and the compiler's job is a page of them — the same reason the detail page
 * reads its own row (invariant 5's note).
 */
async function snapshotOf(taskId: string, connection: Connection): Promise<TaskSnapshot | null> {
  const result = await connection.query<Record<string, unknown>>(
    `SELECT t.id, t.name, t.status_id, t.priority, t.due_at, t.start_at, t.points,
            t.time_estimate_ms, t.task_type_id, t.parent_task_id, t.home_list_id,
            COALESCE(ARRAY(SELECT user_id::text FROM task_assignees WHERE task_id = t.id), '{}') AS assignees,
            COALESCE(ARRAY(SELECT user_id::text FROM task_watchers  WHERE task_id = t.id), '{}') AS watchers,
            COALESCE(ARRAY(SELECT tag_id::text  FROM task_tags      WHERE task_id = t.id), '{}') AS tags
     FROM tasks t WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [taskId],
  );

  const row = result.rows[0];
  if (!row) return null;

  // Instants are ISO strings on an operation, or the inverse posted back by
  // undo arrives as a string and every date helper throws (invariant 10).
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string | null));

  return {
    id: row.id as string,
    name: row.name as string,
    statusId: (row.status_id as string | null) ?? null,
    priority: (row.priority as number | null) ?? null,
    dueAt: iso(row.due_at),
    startAt: iso(row.start_at),
    points: (row.points as number | null) ?? null,
    timeEstimateMs: (row.time_estimate_ms as number | null) ?? null,
    taskTypeId: (row.task_type_id as string | null) ?? null,
    parentTaskId: (row.parent_task_id as string | null) ?? null,
    homeListId: row.home_list_id as string,
    assignees: (row.assignees as string[]) ?? [],
    watchers: (row.watchers as string[]) ?? [],
    tags: (row.tags as string[]) ?? [],
  };
}

/**
 * Do this rule's conditions hold for this task?
 *
 * **Asked of the compiler, because invariant 2 says a reader does not get a
 * query of its own** — and an automation is a reader. The compiled query is
 * wrapped rather than re-derived, so every operator, nested clause and custom
 * field answers exactly as it would in a saved view.
 *
 * **The three presentation flags are overridden on purpose.** A view hides
 * closed tasks, hides archived ones and nests subtasks because a person is
 * browsing. A condition is a question about one task that is already known to
 * exist, and leaving those defaults in place would mean a rule saying "when the
 * status becomes Done" could never fire — the compiled query would have hidden
 * the task the moment it closed. That is the subtlety this delegation costs,
 * and it is worth paying once here rather than maintaining a second evaluator.
 *
 * It runs as the automation's own account (D-126), which is invariant 3's
 * question answered deliberately: a rule sees what the workspace's automation
 * account can see, so two rules in the same container cannot disagree about
 * what counts.
 */
async function conditionsHold(
  rule: AutomationRecord,
  task: TaskSnapshot,
  viewerId: string,
  connection: Connection,
): Promise<boolean> {
  const conditions = rule.rule.conditions;
  if (conditions.conditions.length === 0) return true;

  const compiled = compileViewQuery({
    workspaceId: rule.workspaceId,
    viewerId,
    scope: { kind: "list", id: task.homeListId },
    definition: {
      grouping: { field: "none", dir: "asc" },
      sort: [],
      columns: [],
      filters: {
        ...conditions,
        showClosed: true,
        showSubtasks: 1,
        includeArchived: true,
      },
    },
  });

  const result = await connection.query(
    `SELECT 1 FROM (${compiled.text}) AS candidate WHERE candidate.id = $${compiled.params.length + 1} LIMIT 1`,
    [...compiled.params, task.id],
  );

  return (result.rowCount ?? 0) > 0;
}

export type RunOutcome = "success" | "failed" | "skipped_conditions" | "skipped_self";

/**
 * Evaluates one claimed run and records what happened to it.
 *
 * Every exit writes a terminal status, including the ones that did nothing:
 * a run that silently vanishes is indistinguishable from a rule that never
 * fired, which is the question somebody is always trying to answer when they
 * come to this table.
 */
export async function executeRun(
  run: ClaimedRun,
  connection: Connection = pool(),
): Promise<RunOutcome> {
  const settle = async (status: RunOutcome, error?: string) => {
    await connection.query(
      `UPDATE automation_runs SET status = $2, error = $3, finished_at = now() WHERE id = $1`,
      [run.id, status, error ?? null],
    );
    return status;
  };

  try {
    const rules = await loadAutomations(run.workspaceId, connection);
    const rule = rules.find((candidate) => candidate.id === run.automationId);
    if (!rule) return await settle("skipped_conditions", "The rule is gone or disabled");

    const task = await snapshotOf(run.taskId, connection);
    if (!task) return await settle("skipped_conditions", "The task is gone");

    const actorId = await ensureAutomationActor(run.workspaceId, connection);

    if (!(await conditionsHold(rule, task, actorId, connection))) {
      return await settle("skipped_conditions");
    }

    const ops = compileActions(rule.rule.actions, task, randomUUID);
    if (ops.length === 0) return await settle("success");

    await applyOperations(ops, {
      actorId,
      connection: connection as Pool,
      cause: { automationId: rule.id, runId: run.id },
    });

    return await settle("success");
  } catch (error) {
    return await settle("failed", error instanceof Error ? error.message : String(error));
  }
}

/**
 * One turn of the whole engine, for a workspace.
 *
 * Exported because it is what a loop calls and what a test calls, and those
 * being the same function is what makes the test worth anything.
 */
export async function tickAutomations(
  workspaceId: string,
  connection: Connection = pool(),
): Promise<{ enqueued: number; executed: number; outcomes: RunOutcome[] }> {
  const { enqueued } = await scanForAutomations(workspaceId, connection);
  const claimed = await claimDueRuns(connection);

  const outcomes: RunOutcome[] = [];
  for (const run of claimed) {
    outcomes.push(await executeRun(run, connection));
  }

  return { enqueued, executed: claimed.length, outcomes };
}

/**
 * One turn for every workspace that has a rule to run.
 *
 * **The scan is per workspace and the claim is not**, which is why this is not
 * simply `tickAutomations` in a loop. A cursor belongs to a workspace, so one
 * busy workspace cannot hold up another's scan; a claim is a question about due
 * work and the queue does not care whose it is, so asking once is both cheaper
 * and fairer than asking per workspace in a fixed order.
 *
 * The workspace list is filtered to those with an enabled rule, so an install
 * with no automations costs two cheap queries a tick and nothing else.
 */
export async function drainAutomations(
  connection: Connection = pool(),
): Promise<{ enqueued: number; executed: number }> {
  const workspaces = await connection.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM automations WHERE is_enabled = true`,
  );

  let enqueued = 0;
  for (const row of workspaces.rows) {
    enqueued += (await scanForAutomations(row.workspace_id, connection)).enqueued;
  }

  const claimed = await claimDueRuns(connection);
  for (const run of claimed) {
    await executeRun(run, connection);
  }

  return { enqueued, executed: claimed.length };
}

/**
 * Creating a rule is a configuration change (D-103), so it writes through
 * `logConfigChange` and gets an activity row without an undo entry — a rule is
 * not task data and ⌘Z is not how one is taken back.
 *
 * **It is validated by parsing before it is written**, the same bargain a saved
 * view makes by compiling its definition first: a rule that cannot run should
 * fail in front of the person writing it, not at three in the morning in a
 * queue that records `failed` forever.
 */
export async function createAutomation(
  input: {
    workspaceId: string;
    containerId: string;
    name: string;
    trigger: unknown;
    conditions?: unknown;
    actions: unknown;
    appliesTo?: string;
  },
  context: ConfigContext,
): Promise<string> {
  const name = requireName(input.name, "automation");

  let rule: AutomationRule;
  try {
    rule = parseAutomationRule({
      trigger: input.trigger,
      conditions: input.conditions,
      actions: input.actions,
      appliesTo: input.appliesTo,
    });
  } catch (error) {
    throw new ConfigError(error instanceof AutomationError ? error.message : String(error));
  }

  // Proves the trigger is one something emits, before it is stored.
  verbFor(rule.trigger);

  return inTransaction(context, async (client) => {
    const created = await client.query<{ id: string }>(
      `INSERT INTO automations
         (workspace_id, container_id, name, trigger, conditions, actions, applies_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.workspaceId,
        input.containerId,
        name,
        JSON.stringify(rule.trigger),
        JSON.stringify(rule.conditions),
        JSON.stringify(rule.actions),
        rule.appliesTo,
        context.actorId,
      ],
    );

    const id = created.rows[0]!.id;

    await logConfigChange(client, {
      workspaceId: input.workspaceId,
      actorId: context.actorId,
      objectKind: "automation",
      objectId: id,
      verb: "automation.created",
      newValue: { name },
    });

    return id;
  });
}

export async function setAutomationEnabled(
  automationId: string,
  isEnabled: boolean,
  context: ConfigContext,
): Promise<void> {
  await inTransaction(context, async (client) => {
    const result = await client.query<{ workspace_id: string; is_enabled: boolean }>(
      `UPDATE automations SET is_enabled = $2, updated_at = now() WHERE id = $1
       RETURNING workspace_id, is_enabled`,
      [automationId, isEnabled],
    );

    const row = result.rows[0];
    if (!row) throw new ConfigError("That automation no longer exists");

    await logConfigChange(client, {
      workspaceId: row.workspace_id,
      actorId: context.actorId,
      objectKind: "automation",
      objectId: automationId,
      verb: isEnabled ? "automation.enabled" : "automation.disabled",
      newValue: { isEnabled },
    });
  });
}

export async function deleteAutomation(
  automationId: string,
  context: ConfigContext,
): Promise<void> {
  await inTransaction(context, async (client) => {
    const result = await client.query<{ workspace_id: string; name: string }>(
      `DELETE FROM automations WHERE id = $1 RETURNING workspace_id, name`,
      [automationId],
    );

    const row = result.rows[0];
    if (!row) throw new ConfigError("That automation no longer exists");

    await logConfigChange(client, {
      workspaceId: row.workspace_id,
      actorId: context.actorId,
      objectKind: "automation",
      objectId: automationId,
      verb: "automation.deleted",
      oldValue: { name: row.name },
    });
  });
}
