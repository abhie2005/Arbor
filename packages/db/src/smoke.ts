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
  mentionedIds,
  parseRichText,
  parseStoredDoc,
  renderPlain,
  type Operation,
} from "@arbor/core";
import { createHash, randomUUID } from "node:crypto";

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
import {
  grantAccess,
  listGrants,
  rebuildAccessIndex,
  revokeAccess,
  setContainerPrivacy,
} from "./access";
import {
  purgeExpiredSessions,
  sessionUser,
  setPassword,
  signIn,
  signOut,
} from "./auth";
import { applyOperations } from "./mutations";
import { createTaskType, deleteTaskType, listTaskTypes } from "./task-types";
import {
  createView,
  deleteView,
  duplicateView,
  listViews,
  loadViewById,
  renameView,
  setDefaultView,
  updateViewDefinition,
} from "./views";
import {
  addStatus,
  createStatusSet,
  deleteStatus,
  previewStatusSetAttachment,
  resolveStatusSetFor,
  statusUsage,
  updateStatus,
} from "./statuses";
import { loadComments } from "./comments";
import {
  activitySeen,
  loadAmbient,
  loadInbox,
  markActivitySeen,
  markRead,
  unreadCount,
} from "./notifications";
import { loadTaskHistory } from "./history";
import { type Change, subscribeToChanges } from "./live";
import {
  listAccess,
  requireListAccess,
  requireTaskAccess,
  requireTasksAccess,
  taskAccess,
} from "./task-access";

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
  const one = async (sql: string, params: unknown[] = []) =>
    (await pool.query(sql, params)).rows[0] as Record<string, string>;

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

  // Every container, not just the demo list. A workspace with no default status
  // set resolves nothing for anything outside the tree its one set is attached
  // to, and `resolveStatusSet` throws - correctly, which turned into a 500 on
  // the settings screen the first time a second space existed.
  const everyContainer = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM containers WHERE workspace_id = $1`,
    [ws.id],
  );
  const unresolved: string[] = [];
  for (const container of everyContainer.rows) {
    try {
      await resolveStatusSetFor(ws.id!, container.id, pool);
    } catch {
      unresolved.push(container.name);
    }
  }
  report(
    "every container resolves a status set",
    unresolved.length === 0 ? null : `no set resolves for: ${unresolved.join(", ")}`,
  );

  // --- timeline scope -------------------------------------------------------
  console.log("\ntimeline → overlapping a window, in SQL\n");

  // The question a Gantt asks, which needed nested clauses to express:
  // (start IS NULL OR start < end) AND (due IS NULL OR due >= begin)
  // AND (start IS NOT NULL OR due IS NOT NULL)
  const windowFrom = "2026-09-01T00:00:00.000Z";
  const windowTo = "2026-10-01T00:00:00.000Z";

  const overlapFilters = {
    op: "AND" as const,
    conditions: [
      {
        op: "OR" as const,
        conditions: [
          { field: "startAt" as const, op: "isNull" as const },
          { field: "startAt" as const, op: "lt" as const, value: windowTo },
        ],
      },
      {
        op: "OR" as const,
        conditions: [
          { field: "dueAt" as const, op: "isNull" as const },
          { field: "dueAt" as const, op: "gte" as const, value: windowFrom },
        ],
      },
      {
        op: "OR" as const,
        conditions: [
          { field: "startAt" as const, op: "isNotNull" as const },
          { field: "dueAt" as const, op: "isNotNull" as const },
        ],
      },
    ],
    showClosed: true,
    showSubtasks: 1 as const,
  };

  const onTimeline = async () => {
    const compiled = compileViewQuery({
      ...base,
      scope: { kind: "list", id: list.id! },
      definition: { ...DEFAULT_VIEW_DEFINITION, filters: overlapFilters },
      limit: 500,
    });
    const result = await pool.query<{ name: string }>(compiled.text, compiled.params);
    return result.rows.map((row) => row.name);
  };

  const fixtures: [string, string | null, string | null][] = [
    ["Spans into the window", "2026-08-20", "2026-09-03"],
    ["Spans out of the window", "2026-09-28", "2026-11-04"],
    ["Wholly before", "2026-07-01", "2026-07-30"],
    ["Wholly after", "2026-11-01", "2026-11-30"],
    ["Starts inside, never ends", "2026-09-15", null],
    ["Due inside, never started", null, "2026-09-20"],
    ["No dates at all", null, null],
  ];

  await pool.query(`DELETE FROM tasks WHERE name LIKE '%the window%' OR name IN ($1,$2,$3,$4,$5)`, [
    "Wholly before",
    "Wholly after",
    "Starts inside, never ends",
    "Due inside, never started",
    "No dates at all",
  ]);

  for (const [name, start, due] of fixtures) {
    const row = await one(
      `INSERT INTO tasks (workspace_id, home_list_id, space_id, name, position, created_by,
                          start_at, start_has_time, due_at, due_has_time)
       VALUES ('${ws.id}', '${list.id}', '${space.id}', '${name}', 'a0', '${viewer.id}',
               ${start ? `'${start}T00:00:00Z'` : "NULL"}, false,
               ${due ? `'${due}T00:00:00Z'` : "NULL"}, false)
       RETURNING id`,
    );
    await pool.query(`INSERT INTO task_lists (task_id, list_id, position) VALUES ($1, $2, 'a0')`, [
      row.id,
      list.id,
    ]);
  }

  const visible = await onTimeline();

  report(
    "a task that starts before the window and ends inside it is on the timeline",
    visible.includes("Spans into the window") ? null : "a bar crossing the left edge was dropped",
  );
  report(
    "so is one that starts inside and ends after it",
    visible.includes("Spans out of the window") ? null : "a bar crossing the right edge was dropped",
  );
  report(
    "a task wholly outside the window is not",
    !visible.includes("Wholly before") && !visible.includes("Wholly after")
      ? null
      : "a task from another month appeared",
  );
  report(
    "an open-ended task counts from its start",
    visible.includes("Starts inside, never ends") ? null : "a task with no due date was dropped",
  );
  report(
    "and a task with only a due date counts from that",
    visible.includes("Due inside, never started") ? null : "a task with no start date was dropped",
  );
  report(
    "a task with neither date is not on a timeline at all",
    !visible.includes("No dates at all") ? null : "an unscheduled task appeared on the timeline",
  );

  await pool.query(`DELETE FROM tasks WHERE name LIKE '%the window%' OR name IN ($1,$2,$3,$4,$5)`, [
    "Wholly before",
    "Wholly after",
    "Starts inside, never ends",
    "Due inside, never started",
    "No dates at all",
  ]);

  // --- authentication -------------------------------------------------------
  console.log("\nauthentication → passwords and sessions\n");

  const account = await one("SELECT id, email, password_hash FROM users WHERE email='sam@example.com'");

  report(
    "the seed leaves every demo user able to sign in",
    typeof account.password_hash === "string" && account.password_hash.startsWith("scrypt$")
      ? null
      : `stored hash was ${String(account.password_hash).slice(0, 20)}`,
  );

  report(
    "the password itself is not in the row",
    String(account.password_hash).includes("arbor-demo-2026")
      ? "the plaintext password is stored"
      : null,
  );

  const session = await signIn("Sam@Example.com ", "arbor-demo-2026", {}, pool);
  report(
    "signing in works, and the address is matched case-insensitively",
    session.user.id === account.id ? null : "signed in as the wrong user",
  );

  const stored = await one(
    `SELECT token_hash FROM sessions WHERE user_id = '${account.id}' ORDER BY created_at DESC LIMIT 1`,
  );
  report(
    "the session token is not stored, only a hash of it",
    stored.token_hash !== session.token && String(stored.token_hash).length === 64
      ? null
      : "the raw token is in the database",
  );

  report(
    "the token resolves back to its user",
    (await sessionUser(session.token, pool))?.id === account.id ? null : "the session did not resolve",
  );

  report(
    "a token nobody issued resolves to nobody",
    (await sessionUser("not-a-real-token", pool)) === null ? null : "an invented token was accepted",
  );

  report(
    "the wrong password is refused",
    await expectRejection(() => signIn("sam@example.com", "not the password", {}, pool)),
  );

  // Account enumeration: the two failures must be indistinguishable, or the
  // form tells an attacker which addresses are registered.
  const unknownEmail = await signIn("nobody@example.com", "arbor-demo-2026", {}, pool).catch(
    (error: Error) => error.message,
  );
  const wrongPassword = await signIn("sam@example.com", "wrong password here", {}, pool).catch(
    (error: Error) => error.message,
  );
  report(
    "an unknown email and a wrong password fail identically",
    unknownEmail === wrongPassword ? null : `"${unknownEmail}" vs "${wrongPassword}"`,
  );

  await signOut(session.token, pool);
  report(
    "signing out ends the session immediately",
    (await sessionUser(session.token, pool)) === null ? null : "a signed-out token still resolves",
  );

  const expired = await signIn("sam@example.com", "arbor-demo-2026", {}, pool);
  await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 day' WHERE token_hash = $1`, [
    createHash("sha256").update(expired.token).digest("hex"),
  ]);
  report(
    "an expired session stops resolving without anything having to purge it",
    (await sessionUser(expired.token, pool)) === null ? null : "an expired session still resolves",
  );

  report(
    "purging expired sessions removes them",
    (await purgeExpiredSessions(pool)) >= 1 ? null : "nothing was purged",
  );

  report(
    "a password below the policy is refused before it is hashed",
    await expectRejection(() => setPassword(account.id!, "short", pool)),
  );

  // --- permissions ----------------------------------------------------------
  console.log("\npermissions → grants become the index\n");

  // Everything here is checked *through a compiled view query*, not by reading
  // access_index. The index existing is not the property that matters; a task
  // in a private list not coming back is.
  const founders = await one("SELECT id FROM containers WHERE name='Founders'");
  const hiring = await one("SELECT id FROM containers WHERE name='Hiring'");
  const owner = await one("SELECT id FROM users WHERE email='avery@example.com'");
  const outsider = await one("SELECT id FROM users WHERE email='sam@example.com'");

  const seesHiring = async (userId: string) => {
    const compiled = compileViewQuery({
      workspaceId: ws.id!,
      viewerId: userId,
      scope: { kind: "list", id: hiring.id! },
      definition: DEFAULT_VIEW_DEFINITION,
    });
    const result = await pool.query(compiled.text, compiled.params);
    return (result.rows as { id: string }[]).map((row) => row.id);
  };

  // Cleared first and inserted plainly, with no ON CONFLICT: a check whose
  // fixture can silently not be created reports "nobody can see it" and looks
  // exactly like a permission bug, which is how this cost twenty minutes.
  // --- history --------------------------------------------------------------
  //
  // `activity` has been written to since Phase 2 and this is its first reader,
  // so what is checked is that the log actually answers the question a history
  // asks — newest first, with the values the operation carried — and that it
  // refuses someone who cannot open the task, on its own rather than because a
  // caller remembered to ask.
  console.log("\nhistory → the log, read back\n");

  const historyTask = await one(`SELECT id, status_id FROM tasks WHERE key = 'ENG-390'`);
  const otherStatus = await one(
    `SELECT s.id FROM statuses s JOIN status_sets ss ON ss.id = s.status_set_id
     WHERE ss.name = 'Engineering' AND s.id <> $1 LIMIT 1`,
    [historyTask.status_id],
  );

  await applyOperations(
    [
      {
        kind: "setField",
        taskId: historyTask.id!,
        field: "statusId",
        from: historyTask.status_id!,
        to: otherStatus.id!,
      },
    ],
    { actorId: owner.id!, connection: pool },
  );

  const history = await loadTaskHistory(historyTask.id!, viewer.id!, 60, pool);
  const latest = history[0];

  report(
    "the newest thing that happened is first",
    latest?.verb === "task.status_id_changed" && latest?.actorName === "Avery Mills"
      ? null
      : `read ${JSON.stringify(latest)}`,
  );

  // The log records what the operation carried, which is what makes an entry
  // able to say "Todo → In Review" without the reader storing a second copy.
  report(
    "and carries the values the operation moved between",
    latest?.from === historyTask.status_id && latest?.to === otherStatus.id
      ? null
      : `from ${String(latest?.from)} to ${String(latest?.to)}`,
  );

  const savedHistoryIndex = await pool.query<Record<string, string>>(
    `SELECT workspace_id, principal_id, list_id, permission FROM access_index
     WHERE principal_id = $1 AND list_id = (SELECT home_list_id FROM tasks WHERE id = $2)`,
    [outsider.id, historyTask.id],
  );
  await pool.query(
    `DELETE FROM access_index WHERE principal_id = $1
       AND list_id = (SELECT home_list_id FROM tasks WHERE id = $2)`,
    [outsider.id, historyTask.id],
  );
  report(
    "a viewer who cannot open the task reads no history for it",
    (await loadTaskHistory(historyTask.id!, outsider.id!, 60, pool)).length === 0
      ? null
      : "the log leaked a task the viewer cannot reach",
  );
  for (const row of savedHistoryIndex.rows) {
    await pool.query(
      `INSERT INTO access_index (workspace_id, principal_id, list_id, permission)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [row.workspace_id, row.principal_id, row.list_id, row.permission],
    );
  }

  await applyOperations(
    [
      {
        kind: "setField",
        taskId: historyTask.id!,
        field: "statusId",
        from: otherStatus.id!,
        to: historyTask.status_id!,
      },
    ],
    { actorId: owner.id!, connection: pool },
  );

  // --- live changes ---------------------------------------------------------
  //
  // The transport is Postgres's own: `NOTIFY` inside the transaction that made
  // the change, so the announcement is bound to the commit. That is the whole
  // reason this needs no outbox and no worker, and it is the first thing to
  // assert — followed immediately by the case that proves it, a batch that
  // rolls back and announces nothing.
  console.log("\nlive changes → announced on commit, and only on commit\n");

  const heard: Change[] = [];
  const stopListening = await subscribeToChanges((change) => void heard.push(change));

  /** Delivery is asynchronous; give it a moment before believing the silence. */
  const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

  const liveTask = await one(`SELECT id, home_list_id FROM tasks WHERE key = 'ENG-398'`);

  heard.length = 0;
  await applyOperations(
    [{ kind: "setField", taskId: liveTask.id!, field: "points", from: null, to: 8 }],
    { actorId: owner.id!, connection: pool },
  );
  await settle();

  report(
    "a committed change announces itself, with the list and the actor",
    heard.length === 1 && heard[0]!.l === liveTask.home_list_id && heard[0]!.a === owner.id
      ? null
      : `heard ${JSON.stringify(heard)}`,
  );

  // Two operations, one list, one transaction. Postgres collapses notifications
  // that are identical inside a transaction, which is why the payload carries
  // no per-operation detail: a bulk edit of two hundred tasks in one list is
  // one delivery rather than two hundred, without anything deduplicating here.
  heard.length = 0;
  await applyOperations(
    [
      { kind: "setField", taskId: liveTask.id!, field: "points", from: 8, to: 13 },
      { kind: "setField", taskId: liveTask.id!, field: "priority", from: null, to: 3 },
    ],
    { actorId: owner.id!, connection: pool },
  );
  await settle();

  report(
    "a batch touching one list is one nudge, not one per operation",
    heard.length === 1 ? null : `heard ${heard.length}`,
  );

  // The property the design rests on. A change that did not happen must not be
  // announced — and because `NOTIFY` is transactional, nothing here has to
  // arrange that.
  heard.length = 0;
  const rolledBack = await pool.connect();
  try {
    await rolledBack.query("BEGIN");
    await applyOperations(
      [{ kind: "setField", taskId: liveTask.id!, field: "points", from: 13, to: 99 }],
      { actorId: owner.id!, client: rolledBack },
    );
    await rolledBack.query("ROLLBACK");
  } finally {
    rolledBack.release();
  }
  await settle();

  report(
    "a rolled-back change announces nothing",
    heard.length === 0 &&
    Number((await one(`SELECT points FROM tasks WHERE id = $1`, [liveTask.id])).points) !== 99
      ? null
      : `heard ${heard.length} nudge(s) for a change that did not happen`,
  );

  stopListening();

  await pool.query(`DELETE FROM tasks WHERE name = 'Offer letter template'`);
  const privateTask = await one(
    `INSERT INTO tasks (workspace_id, home_list_id, space_id, name, position, created_by)
     VALUES ('${ws.id}', '${hiring.id}', '${founders.id}', 'Offer letter template', 'a0',
             '${owner.id}')
     RETURNING id`,
  );
  await pool.query(`INSERT INTO task_lists (task_id, list_id, position) VALUES ($1, $2, 'a0')`, [
    privateTask.id,
    hiring.id,
  ]);

  report(
    "the private task the next checks depend on exists",
    privateTask?.id ? null : "the fixture was not created",
  );

  report(
    "a task in a private list is invisible to a member with no grant",
    (await seesHiring(outsider.id!)).length === 0
      ? null
      : "permission leak: the private task came back",
  );

  report(
    "the same task is visible to the member it was shared with",
    (await seesHiring(viewer.id!)).includes(privateTask.id!)
      ? null
      : "the grantee cannot see what they were granted",
  );

  report(
    "and to the owner, who cannot be locked out of their own workspace",
    (await seesHiring(owner.id!)).includes(privateTask.id!)
      ? null
      : "the owner cannot see a private list",
  );

  const accessConfig = { actorId: owner.id!, connection: pool };

  await grantAccess(
    { containerId: hiring.id!, principalKind: "user", principalId: outsider.id!, permission: "view" },
    accessConfig,
  );
  report(
    "granting access makes it visible without a separate rebuild step",
    (await seesHiring(outsider.id!)).includes(privateTask.id!)
      ? null
      : "the grant did not reach the index",
  );

  await revokeAccess(hiring.id!, "user", outsider.id!, accessConfig);
  report(
    "revoking it takes the access away again",
    (await seesHiring(outsider.id!)).length === 0
      ? null
      : "permission leak: revoked access still reads",
  );

  report(
    "revoking a grant that is not there is refused rather than silently ignored",
    await expectRejection(() => revokeAccess(hiring.id!, "user", outsider.id!, accessConfig)),
  );

  // Closing an open space is the operation with the widest blast radius, and
  // the one where an incremental rebuild would be most likely to miss a list.
  await setContainerPrivacy(space.id!, true, accessConfig);
  const closedOff = await pool.query(
    `SELECT 1 FROM access_index WHERE principal_id = $1 AND list_id = $2`,
    [outsider.id, list.id],
  );
  report(
    "making a space private closes every list beneath it",
    closedOff.rows.length === 0 ? null : "a list under a private space is still reachable",
  );

  await setContainerPrivacy(space.id!, false, accessConfig);
  const openedAgain = await pool.query(
    `SELECT 1 FROM access_index WHERE principal_id = $1 AND list_id = $2`,
    [outsider.id, list.id],
  );
  report(
    "and opening it again restores what inheritance implies",
    openedAgain.rows.length === 1 ? null : "reopening a space did not restore access",
  );

  const firstRun = await rebuildAccessIndex(ws.id!, pool);
  const secondRun = await rebuildAccessIndex(ws.id!, pool);
  report(
    "a rebuild that changes nothing produces exactly the same rows",
    JSON.stringify(firstRun) === JSON.stringify(secondRun)
      ? null
      : `${firstRun.length} rows then ${secondRun.length}`,
  );

  const inherited = await listGrants(hiring.id!, pool);
  report(
    "a list reports the grants it inherits, not only its own",
    inherited.some((grant) => grant.inherited && grant.containerName === "Founders")
      ? null
      : `grants seen: ${inherited.map((g) => `${g.containerName}/${g.principalName}`).join(", ")}`,
  );

  // --- writing is scoped too ------------------------------------------------
  console.log("\npermissions → what a viewer may change, not only see\n");

  // Reads were scoped from the beginning and writes were not: an action
  // established who was asking and then wrote. These assert the other half —
  // through the same index, on the same fixture the read checks just used.
  const sprintTask = await one(`SELECT id FROM tasks WHERE key = 'ENG-402'`);

  report(
    "a member may edit a task in a list they can reach",
    (await taskAccess(sprintTask.id!, outsider.id!, pool))?.permission === "edit"
      ? null
      : "a member was refused a list their role reaches",
  );

  report(
    "a member may not edit a task in a private list they have no grant on",
    await expectRejection(() =>
      requireTaskAccess(privateTask.id!, outsider.id!, "edit", pool),
    ),
  );

  // The refusal must not distinguish "not yours" from "not there", or a
  // stranger can enumerate the workspace one id at a time.
  const refusals = await Promise.all([
    messageOf(() => requireTaskAccess(privateTask.id!, outsider.id!, "edit", pool)),
    messageOf(() =>
      requireTaskAccess("00000000-0000-4000-8000-000000000000", outsider.id!, "edit", pool),
    ),
  ]);
  report(
    "and an unreachable task is refused with the same words as one that is gone",
    refusals[0] === refusals[1] ? null : `"${refusals[0]}" vs "${refusals[1]}"`,
  );

  // A view-only grant is only expressible on a private container: elsewhere a
  // member's `edit` baseline is stronger and `strongest` keeps it.
  await grantAccess(
    { containerId: hiring.id!, principalKind: "user", principalId: outsider.id!, permission: "view" },
    accessConfig,
  );

  report(
    "a view-only grant can read the task",
    (await seesHiring(outsider.id!)).includes(privateTask.id!)
      ? null
      : "a view grant did not reach the index",
  );

  report(
    "and cannot write to it",
    await expectRejection(() =>
      requireTaskAccess(privateTask.id!, outsider.id!, "edit", pool),
    ),
  );

  report(
    "a refusal for a task you can see says so, rather than claiming it is gone",
    (await messageOf(() =>
      requireTaskAccess(privateTask.id!, outsider.id!, "edit", pool),
    )) !== (await messageOf(() =>
      requireTaskAccess("00000000-0000-4000-8000-000000000000", outsider.id!, "edit", pool),
    ))
      ? null
      : "an existing task was reported as missing",
  );

  await revokeAccess(hiring.id!, "user", outsider.id!, accessConfig);

  // The undo action takes operations straight from the client, so a batch that
  // names one unreachable task is the shape that matters.
  report(
    "a batch of reachable tasks is allowed",
    await expectNoRejection(() =>
      requireTasksAccess([sprintTask.id!], outsider.id!, "edit", pool),
    ),
  );

  report(
    "a batch with one unreachable task is refused whole",
    await expectRejection(() =>
      requireTasksAccess([sprintTask.id!, privateTask.id!], outsider.id!, "edit", pool),
    ),
  );

  report(
    "a malformed id is a refusal, not a database error",
    await expectRejection(() => requireTaskAccess("not-a-uuid", outsider.id!, "edit", pool)),
  );

  report(
    "creating in a private list is refused for someone with no grant",
    await expectRejection(() => requireListAccess(hiring.id!, outsider.id!, "edit", pool)),
  );

  // --- comments -------------------------------------------------------------
  console.log("\ncomments → operations, not a comment service\n");

  // Written through applyOperations like everything else (D-083), so the
  // activity row and the inverse are the executor's job rather than a service's.
  const commentTask = await one(`SELECT id FROM tasks WHERE key = 'ENG-398'`);
  await pool.query(`DELETE FROM comments WHERE object_id = $1`, [commentTask.id]);
  const firstId = randomUUID();

  await applyOperations(
    [
      {
        kind: "createComment",
        commentId: firstId,
        taskId: commentTask.id!,
        body: parseRichText("Ping @Riley Kaur", [{ id: viewer.id!, name: "Riley Kaur" }]),
        parentId: null,
      },
    ],
    { actorId: owner.id!, connection: pool },
  );

  const written = await one(
    `SELECT body, author_id, object_kind, object_id FROM comments WHERE id = $1`,
    [firstId],
  );
  report(
    "a comment reaches the table with its author and its subject",
    written?.author_id === owner.id &&
      written.object_kind === "task" &&
      written.object_id === commentTask.id
      ? null
      : "the row is missing or points somewhere else",
  );

  // The mention is a node carrying an id, not the characters "@Riley Kaur" —
  // which is the entire reason the stored format is a tree.
  const storedBody = parseStoredDoc(written.body);
  report(
    "a mention is stored as a reference, not as prose",
    storedBody && mentionedIds(storedBody).includes(viewer.id!)
      ? null
      : `stored ${JSON.stringify(written.body).slice(0, 120)}`,
  );

  const commentActivity = await one(
    `SELECT verb, field FROM activity WHERE object_id = $1 ORDER BY at DESC LIMIT 1`,
    [commentTask.id],
  );
  report(
    "and an activity row nobody had to remember to write",
    commentActivity?.verb === "comment.added" && commentActivity.field === firstId
      ? null
      : `logged ${commentActivity?.verb}`,
  );

  const replyId = randomUUID();
  await applyOperations(
    [
      {
        kind: "createComment",
        commentId: replyId,
        taskId: commentTask.id!,
        body: parseRichText("Agreed", []),
        parentId: firstId,
      },
    ],
    { actorId: viewer.id!, connection: pool },
  );

  // One level (D-083): a thread without a bottom is a rendering problem with
  // no natural end.
  report(
    "a reply to a reply is refused",
    await expectRejection(() =>
      applyOperations(
        [
          {
            kind: "createComment",
            commentId: randomUUID(),
            taskId: commentTask.id!,
            body: parseRichText("And again", []),
            parentId: replyId,
          },
        ],
        { actorId: viewer.id!, connection: pool },
      ),
    ),
  );

  // Grafting a thread onto another task's comment would put it in two places.
  report(
    "a reply on a different task from its parent is refused",
    await expectRejection(() =>
      applyOperations(
        [
          {
            kind: "createComment",
            commentId: randomUUID(),
            taskId: privateTask.id!,
            body: parseRichText("Elsewhere", []),
            parentId: firstId,
          },
        ],
        { actorId: owner.id!, connection: pool },
      ),
    ),
  );

  const threaded = await loadComments(commentTask.id!, pool);
  report(
    "comments load threaded one level deep",
    threaded.length === 1 && threaded[0]?.replies.length === 1
      ? null
      : `got ${threaded.length} roots`,
  );

  await applyOperations([{ kind: "deleteComment", commentId: firstId, taskId: commentTask.id! }], {
    actorId: owner.id!,
    connection: pool,
  });

  const afterCommentDelete = await loadComments(commentTask.id!, pool);
  report(
    "a deleted comment with replies stays as a tombstone",
    afterCommentDelete.length === 1 &&
      afterCommentDelete[0]?.deletedAt !== null &&
      afterCommentDelete[0]?.body === null &&
      afterCommentDelete[0]?.replies.length === 1
      ? null
      : "the thread lost its anchor",
  );

  await applyOperations([{ kind: "restoreComment", commentId: firstId, taskId: commentTask.id! }], {
    actorId: owner.id!,
    connection: pool,
  });
  const afterRestore = await loadComments(commentTask.id!, pool);
  report(
    "and undoing the delete brings the words back",
    afterRestore[0]?.body !== null && afterRestore[0]?.deletedAt === null
      ? null
      : "the restored comment has no body",
  );

  // A deleted comment with nothing under it has nothing to hold up.
  const loneId = randomUUID();
  await applyOperations(
    [
      {
        kind: "createComment",
        commentId: loneId,
        taskId: commentTask.id!,
        body: parseRichText("Never mind", []),
        parentId: null,
      },
    ],
    { actorId: owner.id!, connection: pool },
  );
  await applyOperations([{ kind: "deleteComment", commentId: loneId, taskId: commentTask.id! }], {
    actorId: owner.id!,
    connection: pool,
  });
  report(
    "a deleted comment with no replies is not shown at all",
    (await loadComments(commentTask.id!, pool)).every((c) => c.id !== loneId)
      ? null
      : "a tombstone was left with nothing under it",
  );

  // The operation names both the comment and the task; writing to a comment
  // whose task is not the authorized one would make D-080 mean nothing.
  report(
    "an operation naming the wrong task for a comment is refused",
    await expectRejection(() =>
      applyOperations(
        [{ kind: "deleteComment", commentId: replyId, taskId: privateTask.id! }],
        { actorId: owner.id!, connection: pool },
      ),
    ),
  );

  const descriptionDoc = parseRichText("What it does.\n\nAnd why.", []);
  await applyOperations(
    [{ kind: "setDescription", taskId: commentTask.id!, from: null, to: descriptionDoc }],
    { actorId: owner.id!, connection: pool },
  );
  const described = await one(`SELECT description FROM tasks WHERE id = $1`, [commentTask.id]);
  report(
    "a description is the same document a comment is",
    renderPlain(parseStoredDoc(described.description)!) === "What it does.\n\nAnd why."
      ? null
      : `stored ${JSON.stringify(described.description).slice(0, 120)}`,
  );

  // Empty stores NULL, so "has a description" is a question the column answers.
  await applyOperations(
    [{ kind: "setDescription", taskId: commentTask.id!, from: descriptionDoc, to: null }],
    { actorId: owner.id!, connection: pool },
  );
  const cleared = await one(`SELECT description FROM tasks WHERE id = $1`, [commentTask.id]);
  report(
    "and clearing it stores null rather than an empty document",
    cleared.description === null ? null : `stored ${JSON.stringify(cleared.description)}`,
  );

  await pool.query(`DELETE FROM comments WHERE object_id = $1`, [commentTask.id]);

  // --- notifications --------------------------------------------------------
  console.log("\nnotifications → direct signals only, inside the transaction\n");

  await pool.query(`DELETE FROM notifications`);

  const mentionId = randomUUID();
  const fanned = await applyOperations(
    [
      {
        kind: "createComment",
        commentId: mentionId,
        taskId: commentTask.id!,
        body: parseRichText("Over to you @Riley Kaur", [{ id: viewer.id!, name: "Riley Kaur" }]),
        parentId: null,
      },
    ],
    { actorId: owner.id!, connection: pool },
  );

  const notified = await pool.query<{
    user_id: string;
    kind: string;
    activity_id: string | null;
    payload: Record<string, unknown>;
  }>(`SELECT user_id, kind, activity_id, payload FROM notifications`);

  report(
    "a mention writes exactly one row, for the person named",
    notified.rows.length === 1 &&
      notified.rows[0]?.user_id === viewer.id &&
      notified.rows[0]?.kind === "mentioned"
      ? null
      : `wrote ${notified.rows.length} rows`,
  );

  report(
    "and the executor reports what it wrote",
    fanned.notified === 1 ? null : `reported ${fanned.notified}`,
  );

  // The column was declared `uuid` until 0004 and could never have held this.
  report(
    "the row points at the activity that caused it",
    notified.rows[0]?.activity_id != null ? null : "activity_id is null",
  );

  // The schema asks for a rendered summary so an inbox row needs no joins.
  const payload = notified.rows[0]!.payload;
  report(
    "the payload is rendered at write time, not left to be joined",
    String(payload.summary).includes("mentioned you") &&
      String(payload.excerpt).includes("Over to you")
      ? null
      : `payload was ${JSON.stringify(payload)}`,
  );

  await pool.query(`DELETE FROM notifications`);
  await applyOperations(
    [
      {
        kind: "createComment",
        commentId: randomUUID(),
        taskId: commentTask.id!,
        body: parseRichText("Noting this, @Avery Mills", [{ id: owner.id!, name: "Avery Mills" }]),
        parentId: null,
      },
    ],
    { actorId: owner.id!, connection: pool },
  );
  report(
    "nobody is notified about their own action",
    (await one(`SELECT count(*) AS n FROM notifications`)).n === "0"
      ? null
      : "the actor notified themselves",
  );

  // Assigning notifies; watching does not. Fanning out to watchers is the exact
  // shape the table's design note rules out.
  await pool.query(`DELETE FROM notifications`);
  await pool.query(`DELETE FROM task_assignees WHERE task_id = $1 AND user_id = $2`, [
    commentTask.id,
    viewer.id,
  ]);
  await applyOperations(
    [
      { kind: "addRelation", taskId: commentTask.id!, relation: "assignee", targetId: viewer.id! },
      { kind: "addRelation", taskId: commentTask.id!, relation: "watcher", targetId: outsider.id! },
    ],
    { actorId: owner.id!, connection: pool },
  );
  const afterAssign = await pool.query<{ user_id: string; kind: string }>(
    `SELECT user_id, kind FROM notifications`,
  );
  report(
    "assigning notifies and watching does not",
    afterAssign.rows.length === 1 &&
      afterAssign.rows[0]?.user_id === viewer.id &&
      afterAssign.rows[0]?.kind === "assigned"
      ? null
      : `wrote ${JSON.stringify(afterAssign.rows)}`,
  );

  // A field change is a real event addressed to nobody. Writing a row for it
  // would be the two-hundred-watcher problem arriving through another door.
  await pool.query(`DELETE FROM notifications`);
  await applyOperations(
    [{ kind: "setField", taskId: commentTask.id!, field: "priority", from: null, to: 2 }],
    { actorId: owner.id!, connection: pool },
  );
  report(
    "an ambient change writes no notification",
    (await one(`SELECT count(*) AS n FROM notifications`)).n === "0"
      ? null
      : "a field change notified someone",
  );

  // Never tell someone about a task they cannot open. The mention flow asks
  // before posting (D-084), but an assignment does not, and the worker will
  // apply operations with no UI in front of it at all.
  await pool.query(`DELETE FROM notifications`);
  await applyOperations(
    [
      {
        kind: "createComment",
        commentId: randomUUID(),
        taskId: privateTask.id!,
        body: parseRichText("Take a look @Sam Petrov", [{ id: outsider.id!, name: "Sam Petrov" }]),
        parentId: null,
      },
    ],
    { actorId: owner.id!, connection: pool },
  );
  report(
    "someone with no access to the task is never notified about it",
    (await one(`SELECT count(*) AS n FROM notifications`)).n === "0"
      ? null
      : "a private task was announced to someone who cannot open it",
  );

  await pool.query(`DELETE FROM notifications`);
  await pool.query(`DELETE FROM comments WHERE object_id = $1`, [commentTask.id]);

  const rootId = randomUUID();
  await applyOperations(
    [
      {
        kind: "createComment",
        commentId: rootId,
        taskId: commentTask.id!,
        body: parseRichText("What do we think?", []),
        parentId: null,
      },
    ],
    { actorId: viewer.id!, connection: pool },
  );
  await applyOperations(
    [
      {
        kind: "createComment",
        commentId: randomUUID(),
        taskId: commentTask.id!,
        body: parseRichText("Ship it", []),
        parentId: rootId,
      },
    ],
    { actorId: owner.id!, connection: pool },
  );
  const replied = await pool.query<{ user_id: string; kind: string }>(
    `SELECT user_id, kind FROM notifications`,
  );
  report(
    "replying notifies the author of the comment being answered",
    replied.rows.length === 1 &&
      replied.rows[0]?.user_id === viewer.id &&
      replied.rows[0]?.kind === "replied"
      ? null
      : `wrote ${JSON.stringify(replied.rows)}`,
  );

  // The inbox is the first read in the app not scoped to one container, and it
  // still has to answer only with tasks the viewer can currently open.
  report(
    "the inbox returns what was written",
    (await loadInbox(viewer.id!, {}, pool)).length === 1 ? null : "the inbox disagrees",
  );

  report(
    "and the badge agrees with it",
    (await unreadCount(viewer.id!, pool)) === 1 ? null : "the count and the list disagree",
  );

  // A notification row records that something happened; it is not a licence to
  // see it. Access revoked after the write must take it out of the inbox.
  const savedIndex = await pool.query<Record<string, string>>(
    `SELECT workspace_id, principal_id, list_id, permission FROM access_index
     WHERE principal_id = $1 AND list_id = (SELECT home_list_id FROM tasks WHERE id = $2)`,
    [viewer.id, commentTask.id],
  );
  await pool.query(
    `DELETE FROM access_index WHERE principal_id = $1
       AND list_id = (SELECT home_list_id FROM tasks WHERE id = $2)`,
    [viewer.id, commentTask.id],
  );
  report(
    "a notification for a task you have lost access to leaves the inbox",
    (await loadInbox(viewer.id!, {}, pool)).length === 0 &&
      (await unreadCount(viewer.id!, pool)) === 0
      ? null
      : "a revoked task is still announced",
  );
  for (const row of savedIndex.rows) {
    await pool.query(
      `INSERT INTO access_index (workspace_id, principal_id, list_id, permission)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [row.workspace_id, row.principal_id, row.list_id, row.permission],
    );
  }

  const beforeRead = await unreadCount(viewer.id!, pool);
  await markRead((await loadInbox(viewer.id!, {}, pool))[0]!.id, viewer.id!, pool);
  report(
    "marking one read takes it out of the badge",
    beforeRead === 1 && (await unreadCount(viewer.id!, pool)) === 0
      ? null
      : "the badge did not change",
  );

  // An id is not permission: marking someone else's notification read must do
  // nothing rather than quietly succeed.
  await pool.query(`DELETE FROM notifications`);
  await applyOperations(
    [
      {
        kind: "createComment",
        commentId: randomUUID(),
        taskId: commentTask.id!,
        body: parseRichText("Ping @Riley Kaur", [{ id: viewer.id!, name: "Riley Kaur" }]),
        parentId: null,
      },
    ],
    { actorId: owner.id!, connection: pool },
  );
  await markRead((await loadInbox(viewer.id!, {}, pool))[0]!.id, outsider.id!, pool);
  report(
    "marking a notification read that is not yours does nothing",
    (await unreadCount(viewer.id!, pool)) === 1 ? null : "someone else cleared it",
  );

  await pool.query(`DELETE FROM notifications`);
  await pool.query(`DELETE FROM comments WHERE object_id = $1`, [commentTask.id]);

  // --- the read-time half ---------------------------------------------------
  //
  // The other side of the same design: nothing is written when a watched task
  // changes, so everything below is assembled from `activity` at read time. The
  // checks use `since` as their isolation rather than deleting log rows —
  // activity is append-only, and a check that truncates the thing it is testing
  // is testing an empty table.
  console.log("\nambient activity → assembled for watchers, written for nobody\n");

  await applyOperations(
    [{ kind: "addRelation", taskId: commentTask.id!, relation: "watcher", targetId: viewer.id! }],
    { actorId: viewer.id!, connection: pool },
  ).catch(() => {
    // Already watching from an earlier check. Not a reason to stop.
  });

  // **From the database's clock, not the host's.** These checks fence on
  // `activity.at`, which Postgres stamps with its own `now()` — and Postgres is
  // in a VM whose clock drifts tens of milliseconds either side of this
  // process's. A fence taken from `new Date()` therefore lets the *previous*
  // section's writes through at random, which looks exactly like the query
  // ignoring its window.
  const dbNow = async (): Promise<Date> =>
    (await pool.query<{ now: Date }>(`SELECT now()`)).rows[0]!.now;

  const ambientFrom = await dbNow();
  const ambient = (since: Date, seenAt: Date | null = null) =>
    loadAmbient(viewer.id!, ws.id!, { since, seenAt }, pool);

  await applyOperations(
    [
      { kind: "setField", taskId: commentTask.id!, field: "priority", from: null, to: 2 },
      { kind: "setField", taskId: commentTask.id!, field: "points", from: null, to: 5 },
    ],
    { actorId: owner.id!, connection: pool },
  );

  const watched = await ambient(ambientFrom);
  report(
    "two changes on a watched task are one row, not two",
    watched.length === 1 && watched[0]!.changes === 2
      ? null
      : `got ${watched.length} row(s), ${watched[0]?.changes} change(s)`,
  );

  // The summary is the pure function's, over what the query grouped. Asserting
  // the sentence rather than its parts: the sentence is what a person reads.
  report(
    "and it names who did what",
    watched[0]?.summary === "Avery Mills changed points and priority"
      ? null
      : `read "${watched[0]?.summary}"`,
  );

  const ownFrom = await dbNow();
  await applyOperations(
    [{ kind: "setField", taskId: commentTask.id!, field: "priority", from: 2, to: 4 }],
    { actorId: viewer.id!, connection: pool },
  );
  report(
    "your own change is not news to you",
    (await ambient(ownFrom)).length === 0 ? null : "the inbox reported the viewer to themselves",
  );

  // Position is movement, not news: a board drag must not put a task in
  // everyone's inbox saying that its order changed.
  const noiseFrom = await dbNow();
  await applyOperations(
    [{ kind: "setField", taskId: commentTask.id!, field: "position", from: null, to: "n" }],
    { actorId: owner.id!, connection: pool },
  );
  report(
    "a reorder is movement rather than news",
    (await ambient(noiseFrom)).length === 0 ? null : "a drag reached the inbox",
  );

  // One event, one place. The mention is addressed to the viewer, so it belongs
  // in the half that was written for them — `activity_id` is how the ambient
  // query knows to leave it alone.
  const mentionFrom = await dbNow();
  await applyOperations(
    [
      {
        kind: "createComment",
        commentId: randomUUID(),
        taskId: commentTask.id!,
        body: parseRichText("Yours now @Riley Kaur", [{ id: viewer.id!, name: "Riley Kaur" }]),
        parentId: null,
      },
    ],
    { actorId: owner.id!, connection: pool },
  );
  report(
    "something that already notified you directly is not repeated ambiently",
    (await loadInbox(viewer.id!, {}, pool)).length === 1 && (await ambient(mentionFrom)).length === 0
      ? null
      : "the same event arrived twice",
  );
  await pool.query(`DELETE FROM notifications`);
  await pool.query(`DELETE FROM comments WHERE object_id = $1`, [commentTask.id]);

  // Watching is not permission. Same join as every other read, on each row's
  // own list, so a revoked grant stops the feed immediately.
  const revokedIndex = await pool.query<Record<string, string>>(
    `SELECT workspace_id, principal_id, list_id, permission FROM access_index
     WHERE principal_id = $1 AND list_id = (SELECT home_list_id FROM tasks WHERE id = $2)`,
    [viewer.id, commentTask.id],
  );
  await pool.query(
    `DELETE FROM access_index WHERE principal_id = $1
       AND list_id = (SELECT home_list_id FROM tasks WHERE id = $2)`,
    [viewer.id, commentTask.id],
  );
  report(
    "activity on a task you can no longer open leaves the feed",
    (await ambient(ambientFrom)).length === 0 ? null : "a revoked task is still reported",
  );
  for (const row of revokedIndex.rows) {
    await pool.query(
      `INSERT INTO access_index (workspace_id, principal_id, list_id, permission)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [row.workspace_id, row.principal_id, row.list_id, row.permission],
    );
  }

  // Watching is the input list, and the check has to say so about *this* task
  // rather than about a person: the seed makes several people watchers, so
  // "someone else's feed is empty" would be asserting the fixture, not the
  // query. Stop watching, and the same activity stops arriving.
  await pool.query(`DELETE FROM task_watchers WHERE task_id = $1 AND user_id = $2`, [
    commentTask.id,
    viewer.id,
  ]);
  report(
    "activity reaches the people watching it and nobody else",
    (await ambient(ambientFrom)).every((row) => row.taskId !== commentTask.id)
      ? null
      : "a task nobody is watching was reported",
  );
  await pool.query(
    `INSERT INTO task_watchers (task_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [commentTask.id, viewer.id],
  );

  // The mark is one timestamp per membership, and it is what "new" means.
  const seenBefore = await activitySeen(viewer.id!, ws.id!, pool);
  report(
    "the feed starts with no mark on it",
    seenBefore === null ? null : `already marked at ${seenBefore.toISOString()}`,
  );

  const stale = await ambient(ambientFrom, await dbNow());
  report(
    "a mark ahead of the activity makes it no longer new",
    stale.length === 1 && stale[0]!.isNew === false
      ? null
      : `got ${stale.length} row(s), isNew ${stale[0]?.isNew}`,
  );

  await markActivitySeen(viewer.id!, ws.id!, pool);
  const seenAfter = await activitySeen(viewer.id!, ws.id!, pool);
  report(
    "marking the feed seen writes one row, not one per event",
    seenAfter !== null && (await ambient(seenAfter)).length === 0
      ? null
      : "the mark did not take",
  );

  // The mark is per member. Someone else's is untouched, which is the same
  // scoping rule the per-row read flag follows.
  report(
    "and it is one person's mark",
    (await activitySeen(owner.id!, ws.id!, pool)) === null
      ? null
      : "marking one member's feed marked another's",
  );

  await pool.query(`UPDATE memberships SET activity_seen_at = NULL WHERE workspace_id = $1`, [ws.id]);

  await pool.query(`DELETE FROM tasks WHERE name = 'Offer letter template'`);

  // --- saved views ---------------------------------------------------------
  console.log("\nsaved views → validated on write\n");

  const seeded = await listViews(ws.id!, list.id!, viewer.id!, pool);
  // One saved view per renderer that exists. Asserting the set rather than a
  // count, so adding a renderer names the view it forgot to seed instead of
  // reporting a number that means nothing on its own.
  const seededTypes = seeded.map((v) => v.type).sort();
  report(
    "every renderer has a seeded view",
    seededTypes.join(",") === "board,calendar,gantt,list,table"
      ? null
      : `got ${seeded.map((v) => `${v.name} (${v.type})`).join(", ")}`,
  );

  const seededCalendar = seeded.find((v) => v.type === "calendar");
  report(
    "the seeded calendar says which date its squares mean",
    seededCalendar?.definition.settings?.dateField === "dueAt"
      ? null
      : `settings were ${JSON.stringify(seededCalendar?.definition.settings)}`,
  );

  const seededTable = seeded.find((v) => v.type === "table");
  report(
    "the seeded table view shows custom field columns",
    seededTable?.definition.columns.some((column) => String(column.field).startsWith("cf:"))
      ? null
      : "no custom field column in the seeded table view",
  );

  report(
    "a view whose definition will not compile is refused",
    await expectRejection(() =>
      createView(
        {
          workspaceId: ws.id!,
          parentId: list.id!,
          type: "list",
          name: `Broken ${Date.now()}`,
          definition: {
            ...DEFAULT_VIEW_DEFINITION,
            // `>` against a dropdown — the compiler rejects it, so saving must too.
            filters: {
              op: "AND",
              conditions: [{ field: `cf:${componentsField.id}`, op: "gt", value: apiOption }],
            },
          },
        },
        config,
      ),
    ),
  );

  const saved = await createView(
    {
      workspaceId: ws.id!,
      parentId: list.id!,
      type: "list",
      name: `Urgent ${Date.now()}`,
      definition: {
        ...DEFAULT_VIEW_DEFINITION,
        filters: { op: "AND", conditions: [{ field: "priority", op: "eq", value: 1 }] },
      },
    },
    config,
  );
  report("a valid view saves", saved.id ? null : "no view came back");

  const compiled = compileViewQuery({
    ...base,
    scope: { kind: "list", id: list.id! },
    definition: saved.definition,
  });
  const savedRows = (await pool.query(compiled.text, compiled.params)).rows as { key: string }[];
  report(
    "the saved definition compiles to the query it described",
    savedRows.length === 1 && savedRows[0]?.key === "ENG-402"
      ? null
      : `expected only the urgent task, got ${savedRows.map((r) => r.key).join(", ")}`,
  );

  await renameView(saved.id, "Urgent work", config);
  const afterRename = await listViews(ws.id!, list.id!, viewer.id!, pool);
  report(
    "renaming a view sticks",
    afterRename.some((v) => v.name === "Urgent work") ? null : "the rename did not land",
  );

  const personal = await duplicateView(saved.id, "My urgent work", config, {
    ownerId: viewer.id!,
  });
  const strangerSees = await listViews(ws.id!, list.id!, stranger.id!, pool);
  report(
    "a personal view is invisible to everyone else",
    strangerSees.every((v) => v.id !== personal.id)
      ? null
      : "someone else's personal view showed up",
  );

  report(
    "a personal view cannot become the shared default",
    await expectRejection(() => setDefaultView(personal.id, config)),
  );

  await setDefaultView(saved.id, config);
  const defaults = (await listViews(ws.id!, list.id!, viewer.id!, pool)).filter(
    (v) => v.isDefault,
  );
  report(
    "exactly one view is the default",
    defaults.length === 1 && defaults[0]?.id === saved.id
      ? null
      : `${defaults.length} defaults: ${defaults.map((v) => v.name).join(", ")}`,
  );

  report(
    "a definition that stops compiling cannot be saved over a good one",
    await expectRejection(() =>
      updateViewDefinition(
        saved.id,
        {
          ...DEFAULT_VIEW_DEFINITION,
          sort: [{ field: `cf:${componentsField.id}`, dir: "asc" }],
        },
        config,
      ),
    ),
  );

  // Columns are not part of the compiled query, so compiling a definition says
  // nothing about them. They are checked on the same write path for the same
  // reason (D-060): this is the end where a broken column is still someone's
  // mistake to fix.
  report(
    "a column naming a field that does not exist cannot be saved",
    await expectRejection(() =>
      updateViewDefinition(
        saved.id,
        {
          ...DEFAULT_VIEW_DEFINITION,
          columns: [{ field: "cf:00000000-0000-4000-8000-00000000dead" }],
        },
        config,
      ),
    ),
  );

  report(
    "a column naming a field that does exist saves",
    await (async () => {
      const columns = [{ field: "name" as const }, { field: `cf:${componentsField.id}` as const }];
      await updateViewDefinition(saved.id, { ...DEFAULT_VIEW_DEFINITION, columns }, config);
      const reloaded = await loadViewById(saved.id, pool);
      return reloaded.definition.columns.length === 2
        ? null
        : `expected 2 columns, stored ${JSON.stringify(reloaded.definition.columns)}`;
    })(),
  );

  // Deleting the default promotes another, so the list still opens on something.
  await deleteView(saved.id, config);
  const afterDelete = await listViews(ws.id!, list.id!, viewer.id!, pool);
  report(
    "deleting the default promotes another",
    afterDelete.filter((v) => v.isDefault).length === 1
      ? null
      : "the container was left with no default",
  );

  await deleteView(personal.id, config);

  // The "last view" rule is exercised on the Backlog list, which has no seeded
  // views. Proving it against Sprint 24 would mean deleting the views the demo
  // workspace ships with — a smoke run must leave the seed as it found it.
  const onlyView = await createView(
    { workspaceId: ws.id!, parentId: backlog.id!, type: "list", name: `Only ${Date.now()}` },
    config,
  );
  report(
    "the last view on a container cannot be deleted",
    await expectRejection(() => deleteView(onlyView.id, config)),
  );
  await pool.query(`DELETE FROM views WHERE id = $1`, [onlyView.id]);

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

async function expectNoRejection(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return `expected it to be allowed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The words a refusal used, so two refusals can be compared for sameness. */
async function messageOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

main().catch((error: unknown) => {
  console.error("Smoke run failed:", error);
  process.exit(1);
});
