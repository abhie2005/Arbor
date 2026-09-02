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

import {
  archiveField,
  changeFieldType,
  createField,
  fieldsAvailableOn,
  loadFieldCatalog,
  previewFieldTypeChange,
  setFieldScopes,
  updateField,
} from "./fields";
import { applyOperations } from "./mutations";
import { createTaskType, deleteTaskType, listTaskTypes } from "./task-types";
import {
  addStatus,
  createStatusSet,
  deleteStatus,
  previewStatusSetAttachment,
  resolveStatusSetFor,
  statusUsage,
  updateStatus,
} from "./statuses";

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
  const backlog = await one("SELECT id FROM containers WHERE name='Backlog'");
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

  // --- configuration engine ------------------------------------------------
  console.log("\nstatus sets → inheritance, validation, migration\n");

  const config = { actorId: viewer.id!, connection: pool };

  const resolved = await resolveStatusSetFor(ws.id!, list.id!, pool);
  report(
    "a list inherits its status set from an ancestor",
    resolved.set.statuses.length === 5 && !resolved.isOwn && resolved.sourceName === "Engineering"
      ? null
      : `got ${resolved.set.statuses.length} statuses from ${resolved.sourceName} (own=${resolved.isOwn})`,
  );

  const preview = await previewStatusSetAttachment(ws.id!, space.id!, pool);
  report(
    "attaching a set reports which containers it would change",
    preview.affectedContainerIds.length >= 3
      ? null
      : `expected the space and its descendants, got ${preview.affectedContainerNames.join(", ")}`,
  );

  report(
    "a set with nothing terminal is refused",
    await expectRejection(() =>
      createStatusSet(
        {
          workspaceId: ws.id!,
          name: "Broken",
          statuses: [
            { name: "One", group: "not_started", color: "#6B7686", position: 0 },
            { name: "Two", group: "active", color: "#5B8DEF", position: 1 },
          ],
        },
        config,
      ),
    ),
  );

  const kanban = await createStatusSet(
    { workspaceId: ws.id!, name: `Kanban ${Date.now()}`, templateKey: "kanban" },
    config,
  );
  report(
    "a template creates a usable set",
    kanban.statuses.length === 4 && kanban.statuses[0]?.position === 0
      ? null
      : `got ${kanban.statuses.length} statuses`,
  );

  const extra = await addStatus(
    kanban.id,
    { name: "Verifying", group: "active", color: "#C77DD8" },
    config,
  );
  report("a status can be added to a set", extra.position === 4 ? null : `position ${extra.position}`);

  report(
    "a status cannot be renamed onto an existing name",
    await expectRejection(() => updateStatus(extra.id, { name: "Blocked" }, config)),
  );

  const shipped = kanban.statuses.find((st) => st.name === "Shipped");
  if (!shipped) throw new Error("smoke: Kanban template lost its Shipped status");

  report(
    "the last terminal status cannot be regrouped away",
    await expectRejection(() => updateStatus(shipped.id, { group: "active" }, config)),
  );

  // Park a task on a status that is about to be deleted, then delete it.
  const migrant = await one(`SELECT id, status_id FROM tasks WHERE key = 'ENG-417'`);
  await applyOperations(
    [
      {
        kind: "setField",
        taskId: migrant.id!,
        field: "statusId",
        from: migrant.status_id!,
        to: extra.id,
      },
    ],
    { actorId: viewer.id!, connection: pool },
  );

  const usage = await statusUsage(extra.id, pool);
  report(
    "deleting a status reports how many tasks would move",
    usage.taskCount === 1 && usage.blockedReason === null && usage.replacements.length === 4
      ? null
      : `count=${usage.taskCount} blocked=${usage.blockedReason} replacements=${usage.replacements.length}`,
  );

  report(
    "a replacement from another set is refused",
    await expectRejection(() => deleteStatus(extra.id, nextStatus.id!, config)),
  );

  const blocked = kanban.statuses.find((st) => st.name === "Blocked")!;
  const deletion = await deleteStatus(extra.id, blocked.id, config);
  const movedTask = await one(`SELECT status_id FROM tasks WHERE id = '${migrant.id}'`);
  report(
    "deleting a status migrates its tasks rather than orphaning them",
    deletion.movedTasks === 1 && movedTask.status_id === blocked.id
      ? null
      : `moved ${deletion.movedTasks}, task now on ${movedTask.status_id}`,
  );

  const migrationEvents = await one(
    `SELECT COUNT(*)::int AS n FROM activity
     WHERE object_id = '${migrant.id}' AND verb = 'task.status_id_changed'`,
  );
  report(
    "the migration is in each task's history, not just the status's",
    Number(migrationEvents.n) >= 2 ? null : `only ${migrationEvents.n} status events on the task`,
  );

  const configEvent = await one(
    `SELECT object_kind, verb, actor_id FROM activity
     WHERE object_kind = 'status' ORDER BY id DESC LIMIT 1`,
  );
  report(
    "a configuration change is attributable in the activity log",
    configEvent.verb === "status.deleted" && configEvent.actor_id === viewer.id
      ? null
      : `got ${configEvent.verb} by ${configEvent.actor_id}`,
  );

  // Restore ENG-417 so re-running the smoke suite starts from the seeded state.
  await applyOperations(
    [
      {
        kind: "setField",
        taskId: migrant.id!,
        field: "statusId",
        from: blocked.id,
        to: migrant.status_id!,
      },
    ],
    { actorId: viewer.id!, connection: pool },
  );
  await pool.query(`DELETE FROM status_sets WHERE id = $1`, [kanban.id]);

  // --- custom fields and task types ----------------------------------------
  console.log("\ncustom fields → placement, scoping, type change\n");

  const bugType = await one(`SELECT id FROM task_types WHERE name = 'Bug'`);

  const onSprint = await fieldsAvailableOn(ws.id!, list.id!, null, pool);
  report(
    "a list inherits its space's fields and excludes scoped ones",
    onSprint.some((f) => f.name === "Story Points") && !onSprint.some((f) => f.name === "Severity")
      ? null
      : `got ${onSprint.map((f) => f.name).join(", ")}`,
  );

  const onBug = await fieldsAvailableOn(ws.id!, list.id!, bugType.id!, pool);
  report(
    "a Bug sees the field scoped to it",
    onBug.some((f) => f.name === "Severity") ? null : "Severity was not offered to a Bug",
  );

  const estimate = await createField(
    {
      workspaceId: ws.id!,
      containerId: list.id!,
      name: `Estimate ${Date.now()}`,
      type: "short_text",
    },
    config,
  );
  report(
    "a field created on a list is local to it",
    estimate.containerId === list.id ? null : `landed on ${estimate.containerId}`,
  );

  const onBacklog = await fieldsAvailableOn(ws.id!, backlog.id!, null, pool);
  report(
    "a sibling list does not see it",
    onBacklog.every((f) => f.id !== estimate.id) ? null : "a list-local field leaked sideways",
  );

  // Two values: one that reads as a number, one that does not.
  const [firstTask, secondTask] = (
    await pool.query<{ id: string }>(
      `SELECT id FROM tasks WHERE home_list_id = $1 AND parent_task_id IS NULL LIMIT 2`,
      [list.id],
    )
  ).rows;

  await applyOperations(
    [
      { kind: "setCustomField", taskId: firstTask!.id, fieldId: estimate.id, from: null, to: "8" },
      {
        kind: "setCustomField",
        taskId: secondTask!.id,
        fieldId: estimate.id,
        from: null,
        to: "about a week",
      },
    ],
    { actorId: viewer.id!, connection: pool },
  );

  const conversion = await previewFieldTypeChange(estimate.id, "number", {}, pool);
  report(
    "changing a field's type reports what would be lost first",
    conversion.convertible === 1 &&
      conversion.unconvertible === 1 &&
      conversion.samples.length === 1
      ? null
      : `convertible=${conversion.convertible} unconvertible=${conversion.unconvertible}`,
  );

  report(
    "an unconfirmed type change that would lose values is refused",
    await expectRejection(() =>
      changeFieldType(estimate.id, "number", {}, {}, config),
    ),
  );

  const changed = await changeFieldType(
    estimate.id,
    "number",
    {},
    { discardUnconvertible: true },
    config,
  );
  const moved = await one(
    `SELECT value_num, value_text FROM field_values
     WHERE field_id = '${estimate.id}' AND task_id = '${firstTask!.id}'`,
  );
  report(
    "a confirmed type change moves values into the new column and clears the old",
    changed.converted === 1 &&
      changed.discarded === 1 &&
      Number(moved.value_num) === 8 &&
      moved.value_text === null
      ? null
      : `converted=${changed.converted} discarded=${changed.discarded} num=${moved.value_num} text=${moved.value_text}`,
  );

  report(
    "removing a dropdown option that tasks still use is refused",
    await expectRejection(() =>
      updateField(
        componentsField.id!,
        { typeConfig: { options: componentOptions.filter((o) => o.name !== "API") } },
        config,
      ),
    ),
  );

  await setFieldScopes(estimate.id, [bugType.id!], config);
  const afterScope = await fieldsAvailableOn(ws.id!, list.id!, null, pool);
  report(
    "scoping a field hides it from other task types immediately",
    afterScope.every((f) => f.id !== estimate.id) ? null : "a scoped field still showed on a Task",
  );

  await archiveField(estimate.id, true, config);
  const catalogAfterArchive = await loadFieldCatalog(ws.id!, pool);
  const visibleAfterArchive = await fieldsAvailableOn(ws.id!, list.id!, bugType.id!, pool);
  report(
    "archiving a field hides it from forms but keeps saved views compiling",
    catalogAfterArchive.has(estimate.id) && visibleAfterArchive.every((f) => f.id !== estimate.id)
      ? null
      : "an archived field was dropped from the catalog, which breaks views that filter on it",
  );

  console.log("\ntask types → default, deletion, field scoping\n");

  const epic = await createTaskType({ workspaceId: ws.id!, name: `Epic ${Date.now()}` }, config);
  await applyOperations(
    [
      {
        kind: "setField",
        taskId: firstTask!.id,
        field: "taskTypeId",
        from: null,
        to: epic.id,
      },
    ],
    { actorId: viewer.id!, connection: pool },
  );

  const typed = await listTaskTypes(ws.id!, pool);
  report(
    "task types report how many tasks use them",
    typed.find((t) => t.id === epic.id)?.taskCount === 1
      ? null
      : `got ${typed.find((t) => t.id === epic.id)?.taskCount}`,
  );

  const removal = await deleteTaskType(epic.id, null, config);
  const untyped = await one(`SELECT task_type_id FROM tasks WHERE id = '${firstTask!.id}'`);
  report(
    "deleting a task type clears it from tasks rather than orphaning them",
    removal.movedTasks === 1 && untyped.task_type_id === null
      ? null
      : `moved ${removal.movedTasks}, task now ${untyped.task_type_id}`,
  );

  await pool.query(`DELETE FROM fields WHERE id = $1`, [estimate.id]);

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
