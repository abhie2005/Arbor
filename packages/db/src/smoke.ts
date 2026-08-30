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
import { DEFAULT_VIEW_DEFINITION, compileViewQuery } from "@arbor/core";
import { Pool } from "pg";

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

  const base = {
    workspaceId: ws.id!,
    viewerId: viewer.id!,
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

  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("Smoke run failed:", error);
  process.exit(1);
});
