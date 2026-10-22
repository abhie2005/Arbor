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
  startOfUtcDay,
} from "@arbor/core";
import { eq, inArray } from "drizzle-orm";

import { rebuildAccessIndex } from "./access";
import { setPassword } from "./auth";
import { createDatabase, pool } from "./client";
import * as s from "./schema";

const DEMO_SLUG = "northwind";
const DEMO_PASSWORD = "arbor-demo-2026";

/**
 * A second workspace, with a member of its own.
 *
 * Every cross-workspace question answered correctly by accident while there was
 * only one: all four demo people were members of Northwind, so a read that
 * forgot to join on the workspace returned the right rows anyway. The
 * people-lists that select `FROM users` with no workspace join are the bug this
 * exists to make expressible, and the only thing that can express it is a person
 * who is in the database and not in the workspace being asked about.
 *
 * **Nothing in it is named what anything in Northwind is named.** The checks
 * look containers, statuses, fields and task types up by name with no workspace
 * join, so a second "Backlog" or a second "Done" would not fail a check — it
 * would quietly answer a different workspace's question, which is a worse
 * failure than the one this fixture is here to catch.
 */
const OUTSIDE_SLUG = "meridian";

async function main() {
  const db = createDatabase();

  for (const slug of [DEMO_SLUG, OUTSIDE_SLUG]) {
    const existing = await db.query.workspaces.findFirst({
      where: eq(s.workspaces.slug, slug),
    });
    if (existing) {
      console.log(`Removing previous workspace ${existing.id} (/${slug})`);
      await db.delete(s.workspaces).where(eq(s.workspaces.id, existing.id));
    }
  }

  // --- people ---------------------------------------------------------------
  const people = [
    { name: "Avery Mills", email: "avery@example.com", initials: "AM" },
    { name: "Riley Kaur", email: "riley@example.com", initials: "RK" },
    { name: "Sam Petrov", email: "sam@example.com", initials: "SP" },
    { name: "Jordan Diaz", email: "jordan@example.com", initials: "JD" },
    // Quinn is a member of Meridian and of nothing else. Four people who were
    // all members of the one workspace is what made every missing workspace
    // join invisible.
    { name: "Quinn Alvarez", email: "quinn@example.com", initials: "QA" },
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
      : await db
          .select()
          .from(s.users)
          .where(inArray(s.users.email, people.map((p) => p.email)));

  /**
   * Bound by address, never by position.
   *
   * The re-seed path returns nothing from `onConflictDoNothing`, so it falls
   * back to selecting the rows that already exist — and a select with no
   * `ORDER BY` returns them in whatever physical order Postgres has them in,
   * which changes every time a row is updated. `setPassword` updates all four
   * on every seed. So `const [avery, riley, sam, jordan] = users` was a coin
   * toss that made Sam the owner and Avery a member, and the permission checks
   * then failed on the *seed*, describing symptoms that had nothing to do with
   * the code they were testing.
   */
  const byEmail = new Map(users.map((user) => [user.email, user]));
  const person = (email: string) => {
    const user = byEmail.get(email);
    if (!user) throw new Error(`seed: expected a user for ${email}`);
    return user;
  };

  const avery = person("avery@example.com");
  const riley = person("riley@example.com");
  const sam = person("sam@example.com");
  const jordan = person("jordan@example.com");
  const quinn = person("quinn@example.com");

  // Every demo user gets the same password, printed below. A seeded account
  // with no password cannot sign in, and "log in as anyone" is the whole point
  // of a demo workspace.
  for (const user of users) {
    await setPassword(user.id, DEMO_PASSWORD, pool());
  }

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

  // A workspace-level default, attached to nothing.
  //
  // Without one, a container outside the Engineering tree resolves no status
  // set at all and `resolveStatusSet` throws - which is correct of it, and
  // meant the settings screen 500ed the moment a second space existed. The
  // demo had exactly one space, so nothing had ever asked.
  const [defaultSet] = await db
    .insert(s.statusSets)
    .values({ workspaceId: workspace.id, name: "Default", isTemplate: false })
    .returning();
  if (!defaultSet) throw new Error("seed: default status set insert failed");

  await db.insert(s.statuses).values([
    { statusSetId: defaultSet.id, name: "Open", group: "not_started", color: "#6B7686", position: 0 },
    { statusSetId: defaultSet.id, name: "Doing", group: "active", color: "#5B8DEF", position: 1 },
    { statusSetId: defaultSet.id, name: "Done", group: "done", color: "#43B581", position: 2 },
  ]);

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

  // Option ids are generated up front and kept, because `field_values` stores
  // the **id**, never the name (D-041). Seeding the name instead produced data
  // that no filter could match and that renaming an option would silently
  // detach — which is the whole failure the id indirection exists to prevent.
  const severityOptions = [
    { id: randomUUID(), name: "S1", color: "#EC5B5B", orderindex: 0 },
    { id: randomUUID(), name: "S2", color: "#E9A23B", orderindex: 1 },
    { id: randomUUID(), name: "S3", color: "#6B7686", orderindex: 2 },
  ];
  const severityId = Object.fromEntries(severityOptions.map((o) => [o.name, o.id]));

  const [severity] = await db
    .insert(s.fields)
    .values({
      workspaceId: workspace.id,
      containerId: space.id,
      name: "Severity",
      type: "drop_down",
      position: 0,
      typeConfig: { options: severityOptions },
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
    // The two instants. See `dueHasTime` below for why there are two and why
    // there were none.
    {
      key: "ENG-421",
      name: "Rotate the staging database credentials",
      status: "Todo",
      priority: 2,
      assignees: [sam.id],
      tags: ["infra"],
      points: "2",
      dueInDays: null,
      // Three days out, not six hours. A seed is read for as long as somebody
      // is working against it, and the one assertion these two rows exist to
      // support is that one is ahead of the clock and one behind it — six hours
      // made that true for an afternoon and then failed the gate with a message
      // about the fixture rather than about any code. Three days is the same
      // staleness the calendar dates above already have.
      dueInHours: 72,
    },
    {
      key: "ENG-419",
      name: "Expire the old deploy keys",
      status: "In Progress",
      priority: 2,
      assignees: [jordan.id],
      tags: ["infra"],
      points: "1",
      dueInDays: null,
      dueInHours: -4,
    },
  ];

  const positions = initialPositions(seedTasks.length);
  const now = Date.now();
  /** So later sections can reach a task by key rather than by index. */
  const taskByKey: Record<string, { id: string }> = {};

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
        // `dueHasTime: false` means this is a calendar day, so it is stored at
        // midnight UTC. Seeding "now + n days" instead put every due date at
        // whatever time the seed ran, which reads as the previous day to any
        // viewer west of UTC — the exact shift the flag exists to prevent.
        //
        // `dueInHours` is the other kind, and until it existed **every seeded
        // due date was a calendar day**. So the instant branch of `dateFrame`
        // was unreachable by `npm test`, `db:smoke`, `check:actions` and a
        // browser pass over seeded data alike — which is how four more copies
        // of D-121 survived the commit that fixed it: the code that formats an
        // instant with no zone cannot be wrong on data that has no instant in
        // it.
        //
        // Two of them, because an instant is the only value `isOverdue`
        // compares against the clock rather than against the day (D-067). One
        // ahead of now and one behind it puts a row on each side of that
        // branch; a single timed task would leave half of it as unreachable as
        // the whole of it was before.
        dueAt:
          t.dueInHours !== undefined
            ? new Date(now + t.dueInHours * 3_600_000)
            : t.dueInDays === null
              ? null
              : startOfUtcDay(new Date(now + t.dueInDays * 86_400_000)),
        dueHasTime: t.dueInHours !== undefined,
        // A start date on some of them, so the timeline has bars rather than a
        // column of single days. Two-thirds of a task's lead time, rounded to
        // a day like the due date it pairs with (D-067).
        startAt:
          t.dueInDays === null || t.dueInDays <= 1
            ? null
            : startOfUtcDay(new Date(now + Math.floor(t.dueInDays / 3) * 86_400_000)),
        startHasTime: false,
        position: positions[i]!,
        createdBy: avery.id,
        completedAt: statusRow.group === "done" ? new Date(now - 86_400_000) : null,
      })
      .returning();
    if (!task) throw new Error(`seed: task ${t.key} insert failed`);
    if (t.key) taskByKey[t.key] = task;

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
        valueText: severityId[t.severity],
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
  const viewPositions = initialPositions(5);
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
    {
      workspaceId: workspace.id,
      parentId: sprint.id,
      parentKind: "list",
      type: "table",
      name: "Table",
      position: viewPositions[2]!,
      createdBy: avery.id,
      // The only seeded view whose columns include custom fields, which is the
      // half of a definition the table is the first renderer to read. Severity
      // is scoped to the Bug task type, so most rows are legitimately empty in
      // that column — worth seeing, because an empty cell and a missing column
      // must not look the same.
      definition: {
        grouping: { field: "none", dir: "asc" },
        sort: [{ field: "position", dir: "asc" }],
        filters: { op: "AND", conditions: [], showClosed: false, showSubtasks: 1 },
        columns: [
          { field: "status" },
          { field: "name", width: 320 },
          { field: "assignee" },
          { field: "priority" },
          { field: "dueAt" },
          { field: `cf:${storyPoints.id}` },
          { field: `cf:${severity.id}` },
          { field: `cf:${components.id}` },
          { field: "tag" },
          { field: "taskType" },
        ],
      },
    },
    {
      workspaceId: workspace.id,
      parentId: sprint.id,
      parentKind: "list",
      type: "calendar",
      name: "Calendar",
      position: viewPositions[3]!,
      createdBy: avery.id,
      // `settings.dateField` is what a calendar means by a square. Seeded
      // explicitly rather than relying on the default, so the setting is
      // exercised by something.
      definition: {
        grouping: { field: "none", dir: "asc" },
        sort: [{ field: "dueAt", dir: "asc" }],
        filters: { op: "AND", conditions: [], showClosed: false, showSubtasks: 1 },
        columns: [{ field: "name" }, { field: "status" }, { field: "dueAt" }],
        settings: { dateField: "dueAt" },
      },
    },
    {
      workspaceId: workspace.id,
      parentId: sprint.id,
      parentKind: "list",
      type: "gantt",
      name: "Timeline",
      position: viewPositions[4]!,
      createdBy: avery.id,
      definition: {
        grouping: { field: "none", dir: "asc" },
        sort: [
          { field: "startAt", dir: "asc" },
          { field: "dueAt", dir: "asc" },
        ],
        filters: { op: "AND", conditions: [], showClosed: false, showSubtasks: 1 },
        columns: [{ field: "name" }, { field: "startAt" }, { field: "dueAt" }],
      },
    },
  ]);

  // --- a conversation -------------------------------------------------------
  // Two comments and a reply on the task the demo opens on, one of them naming
  // someone. An empty comment section demonstrates the same nothing an empty
  // private list did: the format, the threading and the mention node all have
  // to be visible on a fresh seed or nobody looking at the demo learns they
  // exist.
  const sso = taskByKey["ENG-402"];
  if (sso) {
    const [first] = await db
      .insert(s.comments)
      .values({
        workspaceId: workspace.id,
        objectKind: "task",
        objectId: sso.id,
        authorId: riley.id,
        body: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "The redirect loop only happens when the IdP sends a relay state we did not set. " },
                { type: "mention", userId: jordan.id, label: jordan.name },
                { type: "text", text: " has the HAR file." },
              ],
            },
          ],
        },
      })
      .returning();

    if (first) {
      await db.insert(s.comments).values({
        workspaceId: workspace.id,
        objectKind: "task",
        objectId: sso.id,
        parentId: first.id,
        authorId: jordan.id,
        body: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Attached. It reproduces on the second sign-in, never the first." }],
            },
          ],
        },
      });
    }

    await db.insert(s.comments).values({
      workspaceId: workspace.id,
      objectKind: "task",
      objectId: sso.id,
      authorId: avery.id,
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Let us get this out before the release freeze." }],
          },
        ],
      },
    });

    await db
      .update(s.tasks)
      .set({
        description: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Signing in through the identity provider bounces between the callback and the login page until the browser gives up." },
              ],
            },
            {
              type: "paragraph",
              content: [{ type: "text", text: "Only reproducible with an account that has signed in before." }],
            },
          ],
        },
      })
      .where(eq(s.tasks.id, sso.id));
  }

  // --- a private space ------------------------------------------------------
  // One container nobody reaches by default, so the demo exercises the half of
  // the permission model that matters: Riley is granted it explicitly, and
  // everyone else is left out.
  const [privateSpace] = await db
    .insert(s.containers)
    .values({
      workspaceId: workspace.id,
      parentId: null,
      kind: "space",
      name: "Founders",
      position: firstPosition(),
      isPrivate: true,
      createdBy: avery.id,
    })
    .returning();
  if (!privateSpace) throw new Error("seed: private space insert failed");

  const [privateList] = await db
    .insert(s.containers)
    .values({
      workspaceId: workspace.id,
      parentId: privateSpace.id,
      kind: "list",
      name: "Hiring",
      position: firstPosition(),
      createdBy: avery.id,
    })
    .returning();
  if (!privateList) throw new Error("seed: private list insert failed");

  await db.insert(s.grants).values({
    containerId: privateSpace.id,
    principalKind: "user",
    principalId: riley.id,
    permission: "edit",
    grantedBy: avery.id,
  });

  // A task inside it, because an empty private list demonstrates nothing.
  //
  // The seed used to compute the access index by hand as "everyone can manage
  // everything", which meant the demo could not have shown a permission bug
  // even in principle. A private list with no rows in it is the same failure
  // one level down: the index is right, and there is still nothing a broken
  // check could wrongly return. This is the row that a leak would leak.
  const [privateTask] = await db
    .insert(s.tasks)
    .values({
      workspaceId: workspace.id,
      homeListId: privateList.id,
      spaceId: privateSpace.id,
      folderId: null,
      key: "HIRE-1",
      name: "Draft the staff engineer offer",
      statusId: status["Todo"]?.id ?? null,
      priority: 2,
      position: firstPosition(),
      createdBy: avery.id,
    })
    .returning();
  if (!privateTask) throw new Error("seed: private task insert failed");

  await db.insert(s.taskLists).values({
    taskId: privateTask.id,
    listId: privateList.id,
    isHome: true,
    position: firstPosition(),
  });

  // --- a second workspace ---------------------------------------------------
  // Why it exists and why none of its names collide: `OUTSIDE_SLUG` above.
  const [outside] = await db
    .insert(s.workspaces)
    .values({ name: "Meridian", slug: OUTSIDE_SLUG, plan: "free" })
    .returning();
  if (!outside) throw new Error("seed: second workspace insert failed");

  // Quinn is in this one and in nothing else. Sam is in both, and that is the
  // half that keeps a fix honest: a people-list scoped properly and one scoped
  // by accident *both* stop offering Quinn in Northwind, so Quinn alone cannot
  // tell a fix from a coincidence. Only somebody who has to go on appearing in
  // both can.
  await db.insert(s.memberships).values([
    { workspaceId: outside.id, userId: quinn.id, role: "owner" },
    { workspaceId: outside.id, userId: sam.id, role: "member" },
  ]);

  // A workspace with no status set is not a fixture, it is a 500 waiting for
  // the first screen that asks: `resolveStatusSet` throws rather than inventing
  // one. The note on Northwind's workspace-level "Default" set above is this
  // same lesson, learned the first time a second space existed.
  const [outsideSet] = await db
    .insert(s.statusSets)
    .values({ workspaceId: outside.id, name: "Dispatch", isTemplate: false })
    .returning();
  if (!outsideSet) throw new Error("seed: second status set insert failed");

  const outsideStatuses = await db
    .insert(s.statuses)
    .values([
      { statusSetId: outsideSet.id, name: "Queued", group: "not_started", color: "#6B7686", position: 0 },
      { statusSetId: outsideSet.id, name: "Dispatched", group: "active", color: "#5B8DEF", position: 1 },
      { statusSetId: outsideSet.id, name: "Closed out", group: "done", color: "#43B581", position: 2 },
    ])
    .returning();

  const [outsideSpace] = await db
    .insert(s.containers)
    .values({
      workspaceId: outside.id,
      parentId: null,
      kind: "space",
      name: "Field Ops",
      position: firstPosition(),
      settings: { keyPrefix: "OPS" },
      createdBy: quinn.id,
    })
    .returning();
  if (!outsideSpace) throw new Error("seed: second workspace space insert failed");

  const [outsideList] = await db
    .insert(s.containers)
    .values({
      workspaceId: outside.id,
      parentId: outsideSpace.id,
      kind: "list",
      name: "Dispatch board",
      position: firstPosition(),
      createdBy: quinn.id,
    })
    .returning();
  if (!outsideList) throw new Error("seed: second workspace list insert failed");

  // One task in it, for the reason the private list has one: an empty workspace
  // leaks nothing, so a check that reads across the boundary cannot fail.
  // This is the row a missing workspace join would hand to Northwind.
  const [outsideTask] = await db
    .insert(s.tasks)
    .values({
      workspaceId: outside.id,
      homeListId: outsideList.id,
      spaceId: outsideSpace.id,
      folderId: null,
      key: "OPS-1",
      name: "Swap the depot router",
      statusId: outsideStatuses[0]?.id ?? null,
      priority: 3,
      position: firstPosition(),
      createdBy: quinn.id,
    })
    .returning();
  if (!outsideTask) throw new Error("seed: second workspace task insert failed");

  await db.insert(s.taskLists).values({
    taskId: outsideTask.id,
    listId: outsideList.id,
    isHome: true,
    position: firstPosition(),
  });

  // --- access index ---------------------------------------------------------
  // Computed by the real job rather than written by hand. The seed used to
  // insert "everyone can manage everything", which meant the demo could not
  // have shown a permission bug even in principle.
  //
  // Per workspace, because the job is: a rebuild recomputes the workspace it is
  // given and nothing else (D-071). Running it for Northwind alone would leave
  // Meridian with no index rows, and a fixture whose members can see nothing is
  // indistinguishable from the leak it is meant to catch being absent.
  const access = await rebuildAccessIndex(workspace.id, pool());
  const outsideAccess = await rebuildAccessIndex(outside.id, pool());

  const taskCount = await db.$count(s.tasks, eq(s.tasks.workspaceId, workspace.id));
  const outsideTaskCount = await db.$count(s.tasks, eq(s.tasks.workspaceId, outside.id));
  console.log(
    [
      "",
      `  Workspace   ${workspace.name} (/${workspace.slug})`,
      `  Members     4  (sign in as any of them)`,
      `  Password    ${DEMO_PASSWORD}  (every account, both workspaces)`,
      `  Hierarchy   ${space.name} › ${folder.name} › ${sprint.name}  (+ folderless "${backlog.name}")`,
      `  Private     ${privateSpace.name} › ${privateList.name}  (granted to ${riley.name} only)`,
      `  Access      ${access.length} rows, computed by rebuildAccessIndex`,
      `  Statuses    ${statusRows.map((r) => r.name).join(", ")}`,
      `  Fields      Severity (Bug only), Story Points, Components`,
      `  Tasks       ${taskCount}  (ENG-421 and ENG-419 are due at a time, not on a day)`,
      "",
      `  Workspace   ${outside.name} (/${outside.slug})  — the cross-workspace fixture`,
      `  Members     ${quinn.name} (owner, this workspace only), ${sam.name} (member of both)`,
      `  Hierarchy   ${outsideSpace.name} › ${outsideList.name}`,
      `  Access      ${outsideAccess.length} rows`,
      `  Tasks       ${outsideTaskCount}  (OPS-1 — the row a missing workspace join leaks)`,
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
