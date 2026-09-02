/**
 * Proves the view compiler and the database agree.
 *
 * The compiler's unit tests assert on SQL text; this runs that SQL against a
 * real Postgres with the seeded demo workspace. It is the check that catches a
 * compiler change which is still valid TypeScript but no longer valid SQL —
 * and, most importantly, it demonstrates that permission scoping actually
 * filters rows rather than merely appearing in the query.
 *
 *   npm run db:seed && npm run db:smoke
 */
import {
  DEFAULT_VIEW_DEFINITION,
  compileViewQuery,
  invertBatch,
  type Operation,
} from "@arbor/core";
import { Pool } from "pg";

import { loadFieldCatalog } from "./fields";
import { applyOperations } from "./mutations";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://arbor:arbor@localhost:5432/arbor",
});

let failures = 0;

async function check(
  label: string,
  query: { text: string; params: unknown[] },
  expectation: (rows: Record<string, unknown>[]) => string | null,
) {
  const result = await pool.query(query.text, query.params);
  const rows = result.rows as Record<string, unknown>[];
  const problem = expectation(rows);

  if (problem) {
    failures++;
    console.log(`  FAIL  ${label}\n        ${problem}`);
    return;
  }

  const sample = rows
    .slice(0, 3)
    .map((r) => String(r.key ?? "·"))
    .join(" ");
  console.log(`  ok    ${label}  (${rows.length} rows${sample ? `: ${sample}` : ""})`);
}

async function main() {
  const one = async (sql: string) => (await pool.query(sql)).rows[0] as Record<string, string>;

  const ws = await one("SELECT id FROM workspaces WHERE slug='northwind'");
  if (!ws) throw new Error("No demo workspace. Run `npm run db:seed` first.");

  const viewer = await one("SELECT id FROM users WHERE email='riley@example.com'");
  const stranger = await one("SELECT gen_random_uuid() AS id");
  const list = await one("SELECT id FROM containers WHERE name='Sprint 24'");
  const space = await one("SELECT id FROM containers WHERE name='Engineering'");
  const points = await one("SELECT id FROM fields WHERE name='Story Points'");
  const componentsField = await one(
    "SELECT id, type_config::text AS config FROM fields WHERE name='Components'",
  );
  const componentOptions = (
    JSON.parse(componentsField.config!) as { options: { id: string; name: string }[] }
  ).options;
  const apiOption = componentOptions.find((o) => o.name === "API")!.id;

  // The compiler refuses a `cf:` reference without the fields it names (D-042),
  // so the catalog is loaded once and passed with every definition.
  const base = {
    workspaceId: ws.id!,
    viewerId: viewer.id!,
    fields: await loadFieldCatalog(ws.id!, pool),
  };

  console.log("\nview compiler → postgres\n");

  await check(
    "list view returns the sprint's open tasks",
    compileViewQuery({
      ...base,
      scope: { kind: "list", id: list.id! },
      definition: DEFAULT_VIEW_DEFINITION,
    }),
    (rows) => (rows.length > 0 ? null : "expected rows, got none"),
  );

  await check(
    "everything view spans the whole workspace",
    compileViewQuery({
      ...base,
      scope: { kind: "everything" },
      definition: DEFAULT_VIEW_DEFINITION,
    }),
    (rows) => (rows.length > 0 ? null : "expected rows, got none"),
  );

  await check(
    "a user with no access rows sees nothing",
    compileViewQuery({
      workspaceId: ws.id!,
      viewerId: stranger.id!,
      scope: { kind: "everything" },
      definition: DEFAULT_VIEW_DEFINITION,
    }),
    (rows) => (rows.length === 0 ? null : `permission leak: ${rows.length} rows returned`),
  );

  await check(
    "closed tasks are hidden by default",
    compileViewQuery({
      ...base,
      scope: { kind: "list", id: list.id! },
      definition: DEFAULT_VIEW_DEFINITION,
    }),
    (rows) =>
      rows.every((r) => r.status_group !== "closed") ? null : "a closed task leaked into the view",
  );

  await check(
    "assignee + priority filter narrows the result",
    compileViewQuery({
      ...base,
      scope: { kind: "space", id: space.id! },
      definition: {
        ...DEFAULT_VIEW_DEFINITION,
        filters: {
          op: "AND",
          conditions: [
            { field: "assignee", op: "eq", value: viewer.id },
            { field: "priority", op: "lte", value: 2 },
          ],
        },
      },
    }),
    (rows) =>
      rows.every((r) => Number(r.priority) <= 2)
        ? null
        : "a task above the priority threshold was returned",
  );

  await check(
    "custom field filter and sort",
    compileViewQuery({
      ...base,
      scope: { kind: "list", id: list.id! },
      definition: {
        ...DEFAULT_VIEW_DEFINITION,
        grouping: { field: "none", dir: "asc" },
        sort: [{ field: `cf:${points.id}`, dir: "desc" }],
        filters: {
          op: "AND",
          conditions: [{ field: `cf:${points.id}`, op: "gte", value: 5 }],
        },
      },
    }),
    (rows) => (rows.length > 0 ? null : "expected tasks with 5+ story points"),
  );

  await check(
    "a multi-value custom field filters by JSONB containment",
    compileViewQuery({
      ...base,
      scope: { kind: "list", id: list.id! },
      definition: {
        ...DEFAULT_VIEW_DEFINITION,
        grouping: { field: "none", dir: "asc" },
        filters: {
          op: "AND",
          conditions: [{ field: `cf:${componentsField.id}`, op: "eq", value: apiOption }],
        },
      },
    }),
    (rows) => (rows.length === 2 ? null : `expected the two API tasks, got ${rows.length}`),
  );

  await check(
    "'does not have this label' includes tasks with no labels at all",
    compileViewQuery({
      ...base,
      scope: { kind: "list", id: list.id! },
      definition: {
        ...DEFAULT_VIEW_DEFINITION,
        grouping: { field: "none", dir: "asc" },
        filters: {
          op: "AND",
          conditions: [{ field: `cf:${componentsField.id}`, op: "neq", value: apiOption }],
        },
      },
    }),
    (rows) => (rows.length > 2 ? null : "tasks with no Components value were excluded"),
  );

  await check(
    "an empty custom field means no row, not a row holding null",
    compileViewQuery({
      ...base,
      scope: { kind: "list", id: list.id! },
      definition: {
        ...DEFAULT_VIEW_DEFINITION,
        grouping: { field: "none", dir: "asc" },
        filters: {
          op: "AND",
          conditions: [{ field: `cf:${componentsField.id}`, op: "isNull" }],
        },
      },
    }),
    (rows) => (rows.length > 0 ? null : "expected the tasks with no Components value"),
  );

  await check(
    "unassigned filter finds tasks with no assignees at all",
    compileViewQuery({
      ...base,
      scope: { kind: "list", id: list.id! },
      definition: {
        ...DEFAULT_VIEW_DEFINITION,
        filters: { op: "AND", conditions: [{ field: "assignee", op: "isNull" }] },
      },
    }),
    (rows) => (rows.length > 0 ? null : "expected at least one unassigned task"),
  );

  await check(
    "subtasks disappear in showSubtasks mode 3",
    compileViewQuery({
      ...base,
      scope: { kind: "list", id: list.id! },
      definition: {
        ...DEFAULT_VIEW_DEFINITION,
        filters: { op: "AND", conditions: [], showSubtasks: 3 },
      },
    }),
    (rows) =>
      rows.every((r) => r.parent_task_id === null) ? null : "a subtask appeared as a top-level row",
  );

  // --- mutations -----------------------------------------------------------
  console.log("\nmutations → activity log\n");

  const target = await one(`SELECT id, status_id, name FROM tasks WHERE key = 'ENG-415'`);
  const nextStatus = await one(
    `SELECT id FROM statuses WHERE name = 'In Review' LIMIT 1`,
  );

  const beforeActivity = await one(
    `SELECT COUNT(*)::int AS n FROM activity WHERE object_id = '${target.id}'`,
  );

  const change: Operation = {
    kind: "setField",
    taskId: target.id!,
    field: "statusId",
    from: target.status_id!,
    to: nextStatus.id!,
  };

  await applyOperations([change], { actorId: viewer.id!, connection: pool });

  const afterStatus = await one(
    `SELECT status_id, completed_at FROM tasks WHERE id = '${target.id}'`,
  );
  const afterActivity = await one(
    `SELECT COUNT(*)::int AS n FROM activity WHERE object_id = '${target.id}'`,
  );
  const lastEvent = await one(
    `SELECT verb, actor_id, field FROM activity
     WHERE object_id = '${target.id}' ORDER BY id DESC LIMIT 1`,
  );

  report(
    "a field change lands on the task",
    afterStatus.status_id === nextStatus.id ? null : "status did not change",
  );
  report(
    "the same change writes exactly one activity row",
    Number(afterActivity.n) - Number(beforeActivity.n) === 1
      ? null
      : `expected 1 new activity row, got ${Number(afterActivity.n) - Number(beforeActivity.n)}`,
  );
  report(
    "the activity row records the verb and the actor",
    lastEvent.verb === "task.status_id_changed" && lastEvent.actor_id === viewer.id
      ? null
      : `got verb=${lastEvent.verb} actor=${lastEvent.actor_id}`,
  );

  // Undo is the same machinery in reverse — no special-case code path.
  await applyOperations(invertBatch([change]), { actorId: viewer.id!, connection: pool });
  const restored = await one(`SELECT status_id FROM tasks WHERE id = '${target.id}'`);
  report(
    "undo restores the previous value",
    restored.status_id === target.status_id ? null : "undo did not restore the original status",
  );

  // A no-op must not reach the database at all.
  const beforeNoop = await one(
    `SELECT COUNT(*)::int AS n FROM activity WHERE object_id = '${target.id}'`,
  );
  const noopResult = await applyOperations(
    [{ ...change, from: target.status_id!, to: target.status_id! }],
    { actorId: viewer.id!, connection: pool },
  );
  const afterNoop = await one(
    `SELECT COUNT(*)::int AS n FROM activity WHERE object_id = '${target.id}'`,
  );
  report(
    "a no-op writes nothing",
    noopResult.applied === 0 && Number(beforeNoop.n) === Number(afterNoop.n)
      ? null
      : "a no-op reached the database",
  );

  // Moving into a done-group status must stamp completion, and out must clear
  // it — derived server-side so it can never drift from status.
  const doneStatus = await one(`SELECT id FROM statuses WHERE name = 'Done' LIMIT 1`);
  await applyOperations(
    [{ ...change, from: target.status_id!, to: doneStatus.id! }],
    { actorId: viewer.id!, connection: pool },
  );
  const completed = await one(`SELECT completed_at FROM tasks WHERE id = '${target.id}'`);
  report(
    "moving into a done status stamps completed_at",
    completed.completed_at ? null : "completed_at was not set",
  );

  await applyOperations(
    [{ ...change, from: doneStatus.id!, to: target.status_id! }],
    { actorId: viewer.id!, connection: pool },
  );
  const reopened = await one(`SELECT completed_at FROM tasks WHERE id = '${target.id}'`);
  report(
    "moving back out clears completed_at",
    reopened.completed_at === null ? null : "completed_at was not cleared",
  );

  // A custom-field write must land in the column the field's type declares,
  // not the one its JavaScript value suggests.
  const beforeValue = await one(
    `SELECT value_num FROM field_values
     WHERE task_id = '${target.id}' AND field_id = '${points.id}'`,
  );

  await applyOperations(
    [
      {
        kind: "setCustomField",
        taskId: target.id!,
        fieldId: points.id!,
        from: Number(beforeValue.value_num),
        to: 13,
      },
    ],
    { actorId: viewer.id!, connection: pool },
  );

  const afterValue = await one(
    `SELECT value_num, value_text FROM field_values
     WHERE task_id = '${target.id}' AND field_id = '${points.id}'`,
  );
  report(
    "a custom-field write lands in the column its type declares",
    Number(afterValue.value_num) === 13 && afterValue.value_text === null
      ? null
      : `got value_num=${afterValue.value_num} value_text=${afterValue.value_text}`,
  );

  report(
    "a value the field type rejects never reaches the database",
    await expectRejection(() =>
      applyOperations(
        [
          {
            kind: "setCustomField",
            taskId: target.id!,
            fieldId: points.id!,
            from: 13,
            to: "not a number",
          },
        ],
        { actorId: viewer.id!, connection: pool },
      ),
    ),
  );

  await applyOperations(
    [
      {
        kind: "setCustomField",
        taskId: target.id!,
        fieldId: points.id!,
        from: 13,
        to: Number(beforeValue.value_num),
      },
    ],
    { actorId: viewer.id!, connection: pool },
  );

  report(
    "an operation without an actor is refused",
    await expectRejection(() =>
      applyOperations([change], { actorId: "", connection: pool }),
    ),
  );

  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

function report(label: string, problem: string | null) {
  if (problem) {
    failures++;
    console.log(`  FAIL  ${label}\n        ${problem}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

async function expectRejection(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return "expected a rejection, but the call succeeded";
  } catch {
    return null;
  }
}

main().catch((error: unknown) => {
  console.error("Smoke run failed:", error);
  process.exit(1);
});
