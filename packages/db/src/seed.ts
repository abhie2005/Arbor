/**
 * Seeds a demo workspace.
 *
 * A first launch that shows an empty shell is the worst possible first
 * impression for an open-source project. This makes `docker compose up` land on
 * a populated board with real statuses, custom fields, and a nested hierarchy.
 *
 * Idempotent: re-running replaces the demo workspace rather than duplicating it.
 *
 *   npm run db:seed
 */
import { randomUUID } from "node:crypto";

import {
  firstPosition,
  initialPositions,
  positionBetween,
} from "@arbor/core";
import { eq } from "drizzle-orm";

import { createDatabase } from "./client";
import * as s from "./schema";

const DEMO_SLUG = "northwind";

async function main() {
  const db = createDatabase();

  const existing = await db.query.workspaces.findFirst({
    where: eq(s.workspaces.slug, DEMO_SLUG),
  });
  if (existing) {
    console.log(`Removing previous demo workspace ${existing.id}`);
    await db.delete(s.workspaces).where(eq(s.workspaces.id, existing.id));
  }

  // --- people ---------------------------------------------------------------
  const people = [
    { name: "Avery Mills", email: "avery@example.com", initials: "AM" },
    { name: "Riley Kaur", email: "riley@example.com", initials: "RK" },
    { name: "Sam Petrov", email: "sam@example.com", initials: "SP" },
    { name: "Jordan Diaz", email: "jordan@example.com", initials: "JD" },
  ];

  const insertedUsers = await db
    .insert(s.users)
    .values(
      people.map((p) => ({
        email: p.email,
        name: p.name,
        emailVerifiedAt: new Date(),
      })),
    )
    .onConflictDoNothing()
    .returning();

  const users =
    insertedUsers.length > 0
      ? insertedUsers
      : await db.select().from(s.users).limit(people.length);

  const [avery, riley, sam, jordan] = users;
  if (!avery || !riley || !sam || !jordan) throw new Error("seed: expected four users");

  // --- workspace ------------------------------------------------------------
  const [workspace] = await db
    .insert(s.workspaces)
    .values({ name: "Northwind", slug: DEMO_SLUG, plan: "free" })
    .returning();
  if (!workspace) throw new Error("seed: workspace insert failed");

  await db.insert(s.memberships).values([
    { workspaceId: workspace.id, userId: avery.id, role: "owner" },
    { workspaceId: workspace.id, userId: riley.id, role: "member" },
    { workspaceId: workspace.id, userId: sam.id, role: "member" },
    { workspaceId: workspace.id, userId: jordan.id, role: "member" },
  ]);

  // --- statuses -------------------------------------------------------------
  const [statusSet] = await db
    .insert(s.statusSets)
    .values({ workspaceId: workspace.id, name: "Engineering", isTemplate: false })
    .returning();
  if (!statusSet) throw new Error("seed: status set insert failed");

  const statusRows = await db
    .insert(s.statuses)
    .values([
      { statusSetId: statusSet.id, name: "Todo", group: "not_started", color: "#6B7686", position: 0 },
      { statusSetId: statusSet.id, name: "In Progress", group: "active", color: "#5B8DEF", position: 1 },
      { statusSetId: statusSet.id, name: "In Review", group: "active", color: "#C77DD8", position: 2 },
      { statusSetId: statusSet.id, name: "Done", group: "done", color: "#43B581", position: 3 },
      { statusSetId: statusSet.id, name: "Complete", group: "closed", color: "#4A5563", position: 4 },
    ])
    .returning();

  const status = Object.fromEntries(statusRows.map((r) => [r.name, r]));

  // --- hierarchy: space → folder → subfolder → list, plus a folderless list --
  const [space] = await db
    .insert(s.containers)
    .values({
      workspaceId: workspace.id,
      parentId: null,
      kind: "space",
      name: "Engineering",
      position: firstPosition(),
      settings: { keyPrefix: "ENG" },
    })
    .returning();
  if (!space) throw new Error("seed: space insert failed");

  await db
    .update(s.statusSets)
    .set({ containerId: space.id })
    .where(eq(s.statusSets.id, statusSet.id));

  const spaceChildPositions = initialPositions(2);

  const [folder] = await db
    .insert(s.containers)
    .values({
      workspaceId: workspace.id,
      parentId: space.id,
      kind: "folder",
      name: "Platform",
      position: spaceChildPositions[0]!,
    })
    .returning();
  if (!folder) throw new Error("seed: folder insert failed");

  // A folderless list, sitting directly in the space.
  const [backlog] = await db
    .insert(s.containers)
    .values({
      workspaceId: workspace.id,
      parentId: space.id,
      kind: "list",
      name: "Backlog",
      position: spaceChildPositions[1]!,
    })
    .returning();
  if (!backlog) throw new Error("seed: backlog insert failed");

  const [sprint] = await db
    .insert(s.containers)
    .values({
      workspaceId: workspace.id,
      parentId: folder.id,
      kind: "list",
      name: "Sprint 24",
      position: firstPosition(),
    })
    .returning();
  if (!sprint) throw new Error("seed: sprint insert failed");

  // --- task types and custom fields ----------------------------------------
  const taskTypeRows = await db
    .insert(s.taskTypes)
    .values([
      { workspaceId: workspace.id, name: "Task", isDefault: true },
      { workspaceId: workspace.id, name: "Bug", isDefault: false },
    ])
    .returning();

  const bugType = taskTypeRows.find((t) => t.name === "Bug");
  if (!bugType) throw new Error("seed: bug task type missing");

  const [severity] = await db
    .insert(s.fields)
    .values({
      workspaceId: workspace.id,
      containerId: space.id,
      name: "Severity",
      type: "drop_down",
      position: 0,
      typeConfig: {
        options: [
          { id: randomUUID(), name: "S1", color: "#EC5B5B", orderindex: 0 },
          { id: randomUUID(), name: "S2", color: "#E9A23B", orderindex: 1 },
          { id: randomUUID(), name: "S3", color: "#6B7686", orderindex: 2 },
        ],
      },
    })
    .returning();
  if (!severity) throw new Error("seed: severity field insert failed");

  // Scoped to Bug only — a Task never renders this field.
  await db.insert(s.fieldScopes).values({ fieldId: severity.id, taskTypeId: bugType.id });

  const [storyPoints] = await db
    .insert(s.fields)
    .values({
      workspaceId: workspace.id,
      containerId: space.id,
      name: "Story Points",
      type: "number",
      position: 1,
    })
    .returning();
  if (!storyPoints) throw new Error("seed: story points field insert failed");

  // A multi-value field, so `value_json` and the JSONB containment path in the
  // compiler are exercised by the seed rather than only by unit tests.
  const componentOptions = ["API", "Web", "Infra"].map((name, i) => ({
    id: randomUUID(),
    name,
    color: ["#5B8DEF", "#C77DD8", "#43B581"][i]!,
    orderindex: i,
  }));

  const [components] = await db
    .insert(s.fields)
    .values({
      workspaceId: workspace.id,
      containerId: space.id,
      name: "Components",
      type: "labels",
      position: 2,
      typeConfig: { options: componentOptions },
    })
    .returning();
  if (!components) throw new Error("seed: components field insert failed");

  const componentId = Object.fromEntries(componentOptions.map((o) => [o.name, o.id]));

  // --- tags -----------------------------------------------------------------
  const tagRows = await db
    .insert(s.tags)
    .values([
      { workspaceId: workspace.id, spaceId: space.id, name: "auth", color: "#EC5B5B" },
      { workspaceId: workspace.id, spaceId: space.id, name: "platform", color: "#5B8DEF" },
      { workspaceId: workspace.id, spaceId: space.id, name: "infra", color: "#43B581" },
    ])
    .returning();
  const tag = Object.fromEntries(tagRows.map((t) => [t.name, t]));

  // --- tasks ----------------------------------------------------------------
  const seedTasks = [
    {
      key: "ENG-402",
      name: "Fix auth redirect loop on SSO callback",
      status: "In Progress",
      priority: 1,
      assignees: [riley.id, jordan.id],
      tags: ["auth"],
      points: "3",
      dueInDays: 2,
      type: bugType.id,
      severity: "S1",
      components: ["API", "Web"],
    },
    {
      key: "ENG-398",
      name: "Rate limit the public API",
      status: "In Progress",
      priority: 2,
      assignees: [sam.id],
      tags: ["platform"],
      points: "5",
      dueInDays: 5,
      components: ["API"],
    },
    {
      key: "ENG-411",
      name: "Migrate the access index to a background job",
      status: "In Progress",
      priority: 2,
      assignees: [avery.id],
      tags: ["infra"],
      points: "8",
      dueInDays: null,
      components: ["Infra"],
    },
    {
      key: "ENG-415",
      name: "Board drag performance above 500 cards",
      status: "Todo",
      priority: 3,
      assignees: [sam.id],
      tags: ["platform"],
      points: "5",
      dueInDays: 7,
    },
    {
      key: "ENG-417",
      name: "Fractional index helper for drag reorder",
      status: "Todo",
      priority: 4,
      assignees: [],
      tags: [],
      points: "2",
      dueInDays: null,
    },
    {
      key: "ENG-390",
      name: "Webhook signature verification",
      status: "In Review",
      priority: 3,
      assignees: [jordan.id],
      tags: ["platform"],
      points: "3",
      dueInDays: 3,
    },
    {
      key: "ENG-380",
      name: "Seed script for the demo workspace",
      status: "Done",
      priority: 3,
      assignees: [avery.id],
      tags: [],
      points: "1",
      dueInDays: -2,
    },
  ];

  const positions = initialPositions(seedTasks.length);
  const now = Date.now();

  for (const [i, t] of seedTasks.entries()) {
    const statusRow = status[t.status];
    if (!statusRow) throw new Error(`seed: unknown status ${t.status}`);

    const [task] = await db
      .insert(s.tasks)
      .values({
        workspaceId: workspace.id,
        homeListId: sprint.id,
        spaceId: space.id,
        folderId: folder.id,
        key: t.key,
        name: t.name,
        statusId: statusRow.id,
        taskTypeId: t.type ?? null,
        priority: t.priority,
        points: t.points,
        dueAt: t.dueInDays === null ? null : new Date(now + t.dueInDays * 86_400_000),
        dueHasTime: false,
        position: positions[i]!,
        createdBy: avery.id,
        completedAt: statusRow.group === "done" ? new Date(now - 86_400_000) : null,
      })
      .returning();
    if (!task) throw new Error(`seed: task ${t.key} insert failed`);

    // Home-list membership is a row in task_lists too, so every query path is
    // exercised by the seed rather than only the denormalized column.
    await db.insert(s.taskLists).values({
      taskId: task.id,
      listId: sprint.id,
      isHome: true,
      position: positions[i]!,
    });

    if (t.assignees.length > 0) {
      await db
        .insert(s.taskAssignees)
        .values(t.assignees.map((userId) => ({ taskId: task.id, userId })));
      await db
        .insert(s.taskWatchers)
        .values(t.assignees.map((userId) => ({ taskId: task.id, userId })));
    }

    for (const name of t.tags) {
      const row = tag[name];
      if (row) await db.insert(s.taskTags).values({ taskId: task.id, tagId: row.id });
    }

    if (t.severity) {
      await db.insert(s.fieldValues).values({
        taskId: task.id,
        fieldId: severity.id,
        valueText: t.severity,
      });
    }

    await db.insert(s.fieldValues).values({
      taskId: task.id,
      fieldId: storyPoints.id,
      valueNum: Number(t.points),
    });

    if (t.components) {
      await db.insert(s.fieldValues).values({
        taskId: task.id,
        fieldId: components.id,
        valueJson: t.components.map((name) => componentId[name]),
      });
    }

    await db.insert(s.activity).values({
      workspaceId: workspace.id,
      actorId: avery.id,
      objectKind: "task",
      objectId: task.id,
      verb: "task.created",
      listId: sprint.id,
    });
  }

  // A subtask, to prove the self-reference works end to end.
  const parent = await db.query.tasks.findFirst({
    where: eq(s.tasks.key, "ENG-402"),
  });
  if (parent) {
    const subPositions = initialPositions(2);
    for (const [i, name] of ["Reproduce with a clean profile", "Add a failing integration test"].entries()) {
      const [sub] = await db
        .insert(s.tasks)
        .values({
          workspaceId: workspace.id,
          homeListId: sprint.id,
          parentTaskId: parent.id,
          spaceId: space.id,
          folderId: folder.id,
          name,
          statusId: status["Done"]!.id,
          position: subPositions[i]!,
          createdBy: riley.id,
        })
        .returning();
      if (sub) {
        await db.insert(s.taskLists).values({
          taskId: sub.id,
          listId: sprint.id,
          isHome: true,
          position: subPositions[i]!,
        });
      }
    }
  }

  // --- default views --------------------------------------------------------
  const viewPositions = initialPositions(2);
  await db.insert(s.views).values([
    {
      workspaceId: workspace.id,
      parentId: sprint.id,
      parentKind: "list",
      type: "list",
      name: "List",
      position: viewPositions[0]!,
      createdBy: avery.id,
      definition: {
        grouping: { field: "status", dir: "asc" },
        sort: [{ field: "position", dir: "asc" }],
        filters: { op: "AND", conditions: [], showClosed: false, showSubtasks: 2 },
        columns: [
          { field: "status" },
          { field: "name" },
          { field: "assignee" },
          { field: "priority" },
          { field: "dueAt" },
        ],
      },
    },
    {
      workspaceId: workspace.id,
      parentId: sprint.id,
      parentKind: "list",
      type: "board",
      name: "Board",
      position: viewPositions[1]!,
      createdBy: avery.id,
      definition: {
        grouping: { field: "status", dir: "asc" },
        sort: [{ field: "position", dir: "asc" }],
        filters: { op: "AND", conditions: [], showClosed: false, showSubtasks: 1 },
        columns: [{ field: "name" }, { field: "assignee" }, { field: "priority" }],
      },
    },
  ]);

  // --- access index ---------------------------------------------------------
  // Normally rebuilt by the worker. Seeded directly here so the demo has
  // working permissions before any background job has run.
  const lists = [sprint.id, backlog.id];
  await db.insert(s.accessIndex).values(
    users.flatMap((u) =>
      lists.map((listId) => ({
        workspaceId: workspace.id,
        principalId: u.id,
        listId,
        permission: "manage" as const,
      })),
    ),
  );

  const taskCount = await db.$count(s.tasks);
  console.log(
    [
      "",
      `  Workspace   ${workspace.name} (/${workspace.slug})`,
      `  Members     ${users.length}`,
      `  Hierarchy   ${space.name} › ${folder.name} › ${sprint.name}  (+ folderless "${backlog.name}")`,
      `  Statuses    ${statusRows.map((r) => r.name).join(", ")}`,
      `  Fields      Severity (Bug only), Story Points, Components`,
      `  Tasks       ${taskCount}`,
      "",
      "  Seed complete.",
      "",
    ].join("\n"),
  );

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
