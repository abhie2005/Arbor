import {
  type KeyResultKind,
  GoalError,
  compileAggregate,
  formatKeyResultValue,
  goalProgress,
  isKeyResultKind,
  keyResultProgress,
  parseCurrency,
  parseKeyResultValue,
  parseRollupSource,
  positionBetween,
  serializeKeyResultValue,
} from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";
import { type ConfigContext, ConfigError, inTransaction, logConfigChange, requireName } from "./config";
import { loadFieldCatalog } from "./fields";

/**
 * Goals and key results.
 *
 * **Configuration, not task data** — so this follows `statuses.ts` and
 * `task-types.ts` rather than `applyOperations`. A goal has no task id, and
 * `taskId` is what every operation carries and every write is authorized
 * against (D-080); an operation without one would be a write `undo` could not
 * check. It still gets an activity row, through `logConfigChange`, for the
 * reason every configuration change does (D-016).
 *
 * The interesting half is `resolveRollups`, which is the only place a goal's
 * number comes from. It runs the compiler (D-101) as the goal's **owner**
 * (D-102), so everyone reading a goal reads the same number.
 */

export interface KeyResultRecord {
  id: string;
  goalId: string;
  name: string;
  kind: KeyResultKind;
  start: number;
  target: number;
  /** Null for a rollup that could not be measured — never zero. */
  current: number | null;
  source: Record<string, unknown>;
  position: string;
  /** Filled in by `resolveRollups`, so a screen renders words rather than maths. */
  currentLabel: string;
  targetLabel: string;
  progress: number | null;
  /** Why a rollup has no number, when it has none. */
  unmeasured: string | null;
}

export interface GoalRecord {
  id: string;
  name: string;
  description: string | null;
  ownerId: string | null;
  ownerName: string | null;
  dueAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  keyResults: KeyResultRecord[];
  progress: number | null;
}

type Connection = Pool | PoolClient;

interface GoalRow {
  id: string;
  name: string;
  description: string | null;
  owner_id: string | null;
  owner_name: string | null;
  due_at: Date | null;
  completed_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
}

interface KeyResultRow {
  id: string;
  goal_id: string;
  name: string;
  kind: string;
  start_value: string | null;
  target_value: string | null;
  current_value: string | null;
  source: Record<string, unknown> | null;
  position: string;
}

/**
 * Every goal in a workspace, with its key results and its numbers.
 *
 * Not permission-scoped, because a goal has nothing to scope it to: `goals` has
 * a workspace and an owner and no container, which is the schema saying goals
 * are a workspace-level object. Membership is the boundary — see the gap noted
 * in `docs/STATUS.md`.
 */
export async function listGoals(
  workspaceId: string,
  options: { includeArchived?: boolean } = {},
  connection: Connection = pool(),
): Promise<GoalRecord[]> {
  const goals = await connection.query<GoalRow>(
    `SELECT g.id, g.name, g.description, g.owner_id, u.name AS owner_name,
            g.due_at, g.completed_at, g.archived_at, g.created_at
     FROM goals g
     LEFT JOIN users u ON u.id = g.owner_id
     WHERE g.workspace_id = $1 ${options.includeArchived ? "" : "AND g.archived_at IS NULL"}
     ORDER BY g.completed_at NULLS FIRST, g.due_at NULLS LAST, g.created_at`,
    [workspaceId],
  );

  if (goals.rows.length === 0) return [];

  const keyResults = await connection.query<KeyResultRow>(
    `SELECT id, goal_id, name, kind, start_value, target_value, current_value, source, position
     FROM key_results
     WHERE goal_id = ANY($1::uuid[])
     ORDER BY position`,
    [goals.rows.map((row) => row.id)],
  );

  const byGoal = new Map<string, KeyResultRow[]>();
  for (const row of keyResults.rows) {
    const list = byGoal.get(row.goal_id) ?? [];
    list.push(row);
    byGoal.set(row.goal_id, list);
  }

  const records = await Promise.all(
    goals.rows.map(async (row) => {
      const resolved = await resolveRollups(
        (byGoal.get(row.id) ?? []).map(toRecord),
        { workspaceId, ownerId: row.owner_id },
        connection,
      );

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        dueAt: row.due_at ? row.due_at.toISOString() : null,
        completedAt: row.completed_at ? row.completed_at.toISOString() : null,
        archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
        createdAt: row.created_at.toISOString(),
        keyResults: resolved,
        progress: goalProgress(resolved),
      };
    }),
  );

  return records;
}

/**
 * Runs every rollup and fills in its number.
 *
 * **As the goal's owner, never as the reader** (D-102). The compiler takes a
 * viewer and joins `access_index` for them; handing it the reader would make
 * two people see different progress on one shared commitment.
 *
 * A goal with no owner has no principal to compute as — `owner_id` is `ON
 * DELETE SET NULL` — so its rollups come back unmeasured rather than as zero,
 * and say why. Zero would be a claim that nothing had been done.
 *
 * One query per rollup, run together. A goals screen with five goals of three
 * key results is fifteen small indexed aggregates; a single UNION ALL over all
 * of them is the optimisation available if that ever stops being true, and it
 * is not the shape to reach for first.
 */
export async function resolveRollups(
  keyResults: readonly KeyResultRecord[],
  goal: { workspaceId: string; ownerId: string | null },
  connection: Connection = pool(),
): Promise<KeyResultRecord[]> {
  const needed = keyResults.some((kr) => kr.kind === "rollup");
  if (!needed) return keyResults.map(withLabels);

  if (!goal.ownerId) {
    return keyResults.map((kr) =>
      withLabels(
        kr.kind === "rollup"
          ? { ...kr, current: null, unmeasured: "This goal has no owner to measure it as" }
          : kr,
      ),
    );
  }

  // Loaded once for the whole goal rather than per key result: a definition
  // that names a custom field cannot compile without it (D-042).
  const fields = await loadFieldCatalog(goal.workspaceId, connection as Pool);

  return Promise.all(
    keyResults.map(async (kr) => {
      if (kr.kind !== "rollup") return withLabels(kr);

      try {
        const source = parseRollupSource(kr.source);
        const query = compileAggregate({
          workspaceId: goal.workspaceId,
          viewerId: goal.ownerId!,
          scope: source.scope,
          definition: source.definition,
          aggregate: source.aggregate,
          fields,
        });

        const result = await connection.query<{ value: string | number | null }>(
          query.text,
          query.params,
        );

        const raw = result.rows[0]?.value;
        return withLabels({ ...kr, current: raw === null || raw === undefined ? null : Number(raw) });
      } catch (error) {
        // One broken key result must not take a screen of goals down with it.
        // It reports why, which is also the prompt to fix it.
        return withLabels({
          ...kr,
          current: null,
          unmeasured: error instanceof Error ? error.message : "This rollup could not be measured",
        });
      }
    }),
  );
}

export async function createGoal(
  input: { workspaceId: string; name: string; description?: string | null; ownerId?: string | null; dueAt?: Date | null },
  context: ConfigContext,
): Promise<GoalRecord> {
  const name = requireName(input.name, "goal");

  return inTransaction(context, async (client) => {
    const result = await client.query<GoalRow>(
      `INSERT INTO goals (workspace_id, name, description, owner_id, due_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, description, owner_id, NULL AS owner_name,
                 due_at, completed_at, archived_at, created_at`,
      [
        input.workspaceId,
        name,
        input.description?.trim() || null,
        // Defaults to whoever created it: a goal with no owner cannot be
        // measured at all (D-102), so an unowned one is never the useful
        // starting state.
        input.ownerId ?? context.actorId,
        input.dueAt ?? null,
      ],
    );

    const row = result.rows[0];
    if (!row) throw new ConfigError("Goal insert returned nothing");

    await logConfigChange(client, {
      workspaceId: input.workspaceId,
      actorId: context.actorId,
      objectKind: "goal",
      objectId: row.id,
      verb: "goal.created",
      newValue: { name },
    });

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      ownerId: row.owner_id,
      ownerName: null,
      dueAt: row.due_at ? row.due_at.toISOString() : null,
      completedAt: null,
      archivedAt: null,
      createdAt: row.created_at.toISOString(),
      keyResults: [],
      progress: null,
    };
  });
}

export interface GoalPatch {
  name?: string;
  description?: string | null;
  ownerId?: string | null;
  dueAt?: Date | null;
  completed?: boolean;
  archived?: boolean;
}

/**
 * Edits a goal.
 *
 * `completed` is a timestamp rather than a flag, and it is set here rather than
 * derived from progress. A goal at 100% is not necessarily done — the key
 * results were a proxy, and somebody has to say the thing they were a proxy for
 * actually happened.
 */
export async function updateGoal(
  goalId: string,
  patch: GoalPatch,
  context: ConfigContext,
): Promise<void> {
  return inTransaction(context, async (client) => {
    const current = await client.query<{ workspace_id: string; name: string }>(
      `SELECT workspace_id, name FROM goals WHERE id = $1`,
      [goalId],
    );
    const existing = current.rows[0];
    if (!existing) throw new ConfigError("That goal no longer exists");

    const sets: string[] = [];
    const values: unknown[] = [goalId];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (patch.name !== undefined) add("name", requireName(patch.name, "goal"));
    if (patch.description !== undefined) add("description", patch.description?.trim() || null);
    if (patch.ownerId !== undefined) add("owner_id", patch.ownerId);
    if (patch.dueAt !== undefined) add("due_at", patch.dueAt);
    if (patch.completed !== undefined) add("completed_at", patch.completed ? new Date() : null);
    if (patch.archived !== undefined) add("archived_at", patch.archived ? new Date() : null);

    if (sets.length === 0) return;

    await client.query(`UPDATE goals SET ${sets.join(", ")} WHERE id = $1`, values);

    await logConfigChange(client, {
      workspaceId: existing.workspace_id,
      actorId: context.actorId,
      objectKind: "goal",
      objectId: goalId,
      verb: patch.archived ? "goal.archived" : patch.completed !== undefined ? "goal.completed" : "goal.updated",
      newValue: patch.name ?? null,
    });
  });
}

export async function deleteGoal(goalId: string, context: ConfigContext): Promise<void> {
  return inTransaction(context, async (client) => {
    const current = await client.query<{ workspace_id: string; name: string }>(
      `SELECT workspace_id, name FROM goals WHERE id = $1`,
      [goalId],
    );
    const existing = current.rows[0];
    if (!existing) throw new ConfigError("That goal no longer exists");

    // Key results go with it, by the schema's own cascade. A goal is the only
    // thing that gives one meaning, so an orphan would be unreachable data.
    await client.query(`DELETE FROM goals WHERE id = $1`, [goalId]);

    await logConfigChange(client, {
      workspaceId: existing.workspace_id,
      actorId: context.actorId,
      objectKind: "goal",
      objectId: goalId,
      verb: "goal.deleted",
      oldValue: { name: existing.name },
    });
  });
}

export interface KeyResultInput {
  name: string;
  kind: string;
  start?: unknown;
  target?: unknown;
  current?: unknown;
  source?: Record<string, unknown>;
}

/**
 * Adds a key result, refusing one that cannot be measured.
 *
 * **A rollup is compiled before it is written**, exactly as a saved view is
 * (D-058): a definition that will not compile is refused at the moment somebody
 * writes it rather than the moment somebody opens the goals screen. The number
 * it produces is discarded — this is a validation, not a read.
 */
export async function addKeyResult(
  goalId: string,
  input: KeyResultInput,
  context: ConfigContext,
): Promise<string> {
  return inTransaction(context, async (client) => {
    const goal = await client.query<{ workspace_id: string; owner_id: string | null }>(
      `SELECT workspace_id, owner_id FROM goals WHERE id = $1`,
      [goalId],
    );
    const parent = goal.rows[0];
    if (!parent) throw new ConfigError("That goal no longer exists");

    const prepared = await prepare(input, parent.workspace_id, client);

    const last = await client.query<{ position: string }>(
      `SELECT position FROM key_results WHERE goal_id = $1 ORDER BY position DESC LIMIT 1`,
      [goalId],
    );

    const result = await client.query<{ id: string }>(
      `INSERT INTO key_results
         (goal_id, name, kind, start_value, target_value, current_value, source, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        goalId,
        prepared.name,
        prepared.kind,
        serializeKeyResultValue(prepared.kind, prepared.start),
        serializeKeyResultValue(prepared.kind, prepared.target),
        // A rollup's current value is derived on read and the column stays
        // empty, so nothing can go stale in it (D-102).
        prepared.kind === "rollup" ? null : serializeKeyResultValue(prepared.kind, prepared.current),
        JSON.stringify(prepared.source),
        positionBetween(last.rows[0]?.position ?? null, null),
      ],
    );

    const id = result.rows[0]!.id;

    await logConfigChange(client, {
      workspaceId: parent.workspace_id,
      actorId: context.actorId,
      objectKind: "key_result",
      objectId: id,
      verb: "key_result.created",
      field: goalId,
      newValue: { name: prepared.name, kind: prepared.kind },
    });

    return id;
  });
}

export async function updateKeyResult(
  keyResultId: string,
  patch: { name?: string; current?: unknown; target?: unknown; start?: unknown },
  context: ConfigContext,
): Promise<void> {
  return inTransaction(context, async (client) => {
    const current = await client.query<{ goal_id: string; kind: string; workspace_id: string }>(
      `SELECT kr.goal_id, kr.kind, g.workspace_id
       FROM key_results kr JOIN goals g ON g.id = kr.goal_id
       WHERE kr.id = $1`,
      [keyResultId],
    );
    const existing = current.rows[0];
    if (!existing) throw new ConfigError("That key result no longer exists");
    if (!isKeyResultKind(existing.kind)) throw new ConfigError("That key result has an unknown kind");

    const kind = existing.kind;
    const sets: string[] = [];
    const values: unknown[] = [keyResultId];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (patch.name !== undefined) add("name", requireName(patch.name, "key result"));
    if (patch.start !== undefined) {
      add("start_value", serializeKeyResultValue(kind, parseKeyResultValue(kind, patch.start)));
    }
    if (patch.target !== undefined) {
      add("target_value", serializeKeyResultValue(kind, parseKeyResultValue(kind, patch.target)));
    }
    if (patch.current !== undefined) {
      // Refused rather than ignored: a control that appears to set a number and
      // silently does not is worse than one that says why it cannot (D-065).
      if (kind === "rollup") {
        throw new ConfigError("A rollup key result counts itself — it cannot be set by hand");
      }
      add("current_value", serializeKeyResultValue(kind, parseKeyResultValue(kind, patch.current)));
    }

    if (sets.length === 0) return;
    await client.query(`UPDATE key_results SET ${sets.join(", ")} WHERE id = $1`, values);

    await logConfigChange(client, {
      workspaceId: existing.workspace_id,
      actorId: context.actorId,
      objectKind: "key_result",
      objectId: keyResultId,
      verb: "key_result.updated",
      field: existing.goal_id,
      newValue: patch.current ?? patch.target ?? patch.name ?? null,
    });
  });
}

export async function deleteKeyResult(keyResultId: string, context: ConfigContext): Promise<void> {
  return inTransaction(context, async (client) => {
    const current = await client.query<{ goal_id: string; name: string; workspace_id: string }>(
      `SELECT kr.goal_id, kr.name, g.workspace_id
       FROM key_results kr JOIN goals g ON g.id = kr.goal_id
       WHERE kr.id = $1`,
      [keyResultId],
    );
    const existing = current.rows[0];
    if (!existing) throw new ConfigError("That key result no longer exists");

    await client.query(`DELETE FROM key_results WHERE id = $1`, [keyResultId]);

    await logConfigChange(client, {
      workspaceId: existing.workspace_id,
      actorId: context.actorId,
      objectKind: "key_result",
      objectId: keyResultId,
      verb: "key_result.deleted",
      field: existing.goal_id,
      oldValue: { name: existing.name },
    });
  });
}

/** Who owns a goal and which workspace it is in — for the actions to authorize. */
export async function goalOwnership(
  goalId: string,
  connection: Connection = pool(),
): Promise<{ workspaceId: string; ownerId: string | null } | null> {
  const result = await connection.query<{ workspace_id: string; owner_id: string | null }>(
    `SELECT workspace_id, owner_id FROM goals WHERE id = $1`,
    [goalId],
  );
  const row = result.rows[0];
  return row ? { workspaceId: row.workspace_id, ownerId: row.owner_id } : null;
}

/** The same for a key result, through the goal it belongs to. */
export async function keyResultOwnership(
  keyResultId: string,
  connection: Connection = pool(),
): Promise<{ workspaceId: string; ownerId: string | null; goalId: string } | null> {
  const result = await connection.query<{
    workspace_id: string;
    owner_id: string | null;
    goal_id: string;
  }>(
    `SELECT g.workspace_id, g.owner_id, kr.goal_id
     FROM key_results kr JOIN goals g ON g.id = kr.goal_id
     WHERE kr.id = $1`,
    [keyResultId],
  );
  const row = result.rows[0];
  return row
    ? { workspaceId: row.workspace_id, ownerId: row.owner_id, goalId: row.goal_id }
    : null;
}

/** Validates an incoming key result, compiling a rollup to prove it resolves. */
async function prepare(
  input: KeyResultInput,
  workspaceId: string,
  client: PoolClient,
): Promise<{
  name: string;
  kind: KeyResultKind;
  start: number | null;
  target: number | null;
  current: number | null;
  source: Record<string, unknown>;
}> {
  const name = requireName(input.name, "key result");
  if (!isKeyResultKind(input.kind)) {
    throw new ConfigError(`"${String(input.kind)}" is not a kind of key result`);
  }
  const kind = input.kind;
  const source = input.source ?? {};

  if (kind === "currency") parseCurrency(source);

  if (kind === "rollup") {
    const parsed = parseRollupSource(source);
    const fields = await loadFieldCatalog(workspaceId, client as unknown as Pool);

    // Compiled to prove it can be, and the SQL thrown away. Same rule as a
    // saved view: a definition that will not compile is refused on write, not
    // discovered on read.
    compileAggregate({
      workspaceId,
      // Any principal compiles the same SQL; the number is what differs. This
      // is a syntax check, so the id only has to be well-formed.
      viewerId: "00000000-0000-4000-8000-000000000000",
      scope: parsed.scope,
      definition: parsed.definition,
      aggregate: parsed.aggregate,
      fields,
    });
  }

  const start = parseKeyResultValue(kind, input.start ?? (kind === "boolean" ? false : 0));
  const target = parseKeyResultValue(kind, input.target ?? (kind === "boolean" ? true : 100));
  const current = parseKeyResultValue(kind, input.current ?? (kind === "boolean" ? false : 0));

  if (start === null || target === null) {
    throw new ConfigError("A key result needs somewhere to start and somewhere to reach");
  }

  return { name, kind, start, target, current, source };
}

function toRecord(row: KeyResultRow): KeyResultRecord {
  const kind = isKeyResultKind(row.kind) ? row.kind : "number";
  const source = row.source ?? {};

  return {
    id: row.id,
    goalId: row.goal_id,
    name: row.name,
    kind,
    start: parseKeyResultValue(kind, row.start_value) ?? 0,
    target: parseKeyResultValue(kind, row.target_value) ?? 0,
    current: parseKeyResultValue(kind, row.current_value),
    source,
    position: row.position,
    currentLabel: "",
    targetLabel: "",
    progress: null,
    unmeasured: null,
  };
}

/** The words and the fraction, once the number is known. */
function withLabels(kr: KeyResultRecord): KeyResultRecord {
  return {
    ...kr,
    currentLabel: formatKeyResultValue(kr.kind, kr.current, kr.source),
    targetLabel: formatKeyResultValue(kr.kind, kr.target, kr.source),
    progress: keyResultProgress(kr),
  };
}

export { GoalError };
