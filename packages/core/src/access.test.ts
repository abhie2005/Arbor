import { describe, expect, it } from "vitest";

import {
  type AccessGrant,
  type AccessInputs,
  ROLE_BASELINE,
  affectedContainers,
  resolveAccess,
  satisfies,
  strongest,
} from "./access";
import type { ContainerNode } from "./hierarchy";

const OWNER = "owner-user";
const ADMIN = "admin-user";
const MEMBER = "member-user";
const LIMITED = "limited-user";
const GUEST = "guest-user";
const STRANGER = "stranger-user";
const GROUP = "group-1";

/**
 *   space "Engineering"
 *     folder "Platform"
 *       list "Sprint"
 *     list "Backlog"          (directly in the space, no folder - ADR 1)
 *   space "Secret" (private)
 *     list "Plans"
 */
const containers: ContainerNode[] = [
  { id: "space", parentId: null, kind: "space", name: "Engineering", isPrivate: false },
  { id: "folder", parentId: "space", kind: "folder", name: "Platform", isPrivate: false },
  { id: "sprint", parentId: "folder", kind: "list", name: "Sprint", isPrivate: false },
  { id: "backlog", parentId: "space", kind: "list", name: "Backlog", isPrivate: false },
  { id: "secret", parentId: null, kind: "space", name: "Secret", isPrivate: true },
  { id: "plans", parentId: "secret", kind: "list", name: "Plans", isPrivate: false },
];

const members = [
  { userId: OWNER, role: "owner" as const },
  { userId: ADMIN, role: "admin" as const },
  { userId: MEMBER, role: "member" as const },
  { userId: LIMITED, role: "limited_member" as const },
  { userId: GUEST, role: "guest" as const },
];

function resolve(overrides: Partial<AccessInputs> = {}) {
  return resolveAccess({
    containers,
    grants: [],
    members,
    groupMembers: [],
    ...overrides,
  });
}

const LISTS = new Set(["sprint", "backlog", "plans"]);

/** Only the list rows, which is what every assertion written before D-108 meant. */
const listsFor = (rows: ReturnType<typeof resolveAccess>, userId: string) =>
  rows
    .filter((row) => row.principalId === userId && LISTS.has(row.containerId))
    .map((row) => row.containerId)
    .sort();

const reachableFor = (rows: ReturnType<typeof resolveAccess>, userId: string) =>
  rows.filter((row) => row.principalId === userId).map((row) => row.containerId).sort();

const permissionOn = (
  rows: ReturnType<typeof resolveAccess>,
  userId: string,
  containerId: string,
) =>
  rows.find((row) => row.principalId === userId && row.containerId === containerId)?.permission ??
  null;

describe("an open list", () => {
  it("is reachable by every member, at the permission their role implies", () => {
    const rows = resolve();
    expect(permissionOn(rows, OWNER, "sprint")).toBe("manage");
    expect(permissionOn(rows, ADMIN, "sprint")).toBe("manage");
    expect(permissionOn(rows, MEMBER, "sprint")).toBe("edit");
    expect(permissionOn(rows, LIMITED, "sprint")).toBe("comment");
  });

  it("is not reachable by a guest, who is invited to things rather than to everything", () => {
    expect(permissionOn(resolve(), GUEST, "sprint")).toBeNull();
    expect(ROLE_BASELINE.guest).toBeNull();
  });

  it("covers a list sitting directly in a space, with no folder between", () => {
    expect(listsFor(resolve(), MEMBER)).toContain("backlog");
  });
});

describe("a private container", () => {
  it("is invisible to a member with no grant", () => {
    // The check that matters most in this file: absence of a row is what stops
    // the query from returning the task.
    expect(permissionOn(resolve(), MEMBER, "plans")).toBeNull();
    expect(listsFor(resolve(), MEMBER)).toEqual(["backlog", "sprint"]);
  });

  it("is invisible to an admin, because administering is not reading", () => {
    expect(permissionOn(resolve(), ADMIN, "plans")).toBeNull();
  });

  it("is still reachable by the owner, who cannot be locked out of the workspace", () => {
    expect(permissionOn(resolve(), OWNER, "plans")).toBe("manage");
  });

  it("makes everything beneath it private, not only itself", () => {
    // `plans` is not marked private; its space is. Effective privacy is the
    // whole chain (isEffectivelyPrivate), which is what stops someone from
    // loosening a child below a locked parent.
    expect(containers.find((c) => c.id === "plans")?.isPrivate).toBe(false);
    expect(permissionOn(resolve(), MEMBER, "plans")).toBeNull();
  });
});

describe("a grant", () => {
  const grantOn = (containerId: string, permission: AccessGrant["permission"] = "edit") => [
    { containerId, principalKind: "user" as const, principalId: MEMBER, permission },
  ];

  it("on the list itself opens exactly that list", () => {
    const rows = resolve({ grants: grantOn("plans") });
    expect(permissionOn(rows, MEMBER, "plans")).toBe("edit");
  });

  it("on an ancestor reaches every list beneath it", () => {
    const rows = resolve({ grants: grantOn("secret", "view") });
    expect(permissionOn(rows, MEMBER, "plans")).toBe("view");
  });

  it("does not reach a sibling of the container it was given on", () => {
    const rows = resolve({
      grants: [
        { containerId: "folder", principalKind: "user", principalId: GUEST, permission: "view" },
      ],
    });
    expect(listsFor(rows, GUEST)).toEqual(["sprint"]);
  });

  it("lets a guest into one open list without giving them the rest", () => {
    const rows = resolve({
      grants: [
        { containerId: "backlog", principalKind: "user", principalId: GUEST, permission: "comment" },
      ],
    });
    expect(listsFor(rows, GUEST)).toEqual(["backlog"]);
    expect(permissionOn(rows, GUEST, "backlog")).toBe("comment");
  });

  it("raises a member above their role baseline on that list only", () => {
    const rows = resolve({ grants: grantOn("sprint", "manage") });
    expect(permissionOn(rows, MEMBER, "sprint")).toBe("manage");
    expect(permissionOn(rows, MEMBER, "backlog")).toBe("edit");
  });

  it("never lowers what a role already gives", () => {
    // A "view" grant on top of a member's "edit" baseline is not a demotion:
    // sharing something with someone must not take access away.
    const rows = resolve({ grants: grantOn("sprint", "view") });
    expect(permissionOn(rows, MEMBER, "sprint")).toBe("edit");
  });

  it("to a group reaches each of its members", () => {
    const rows = resolve({
      grants: [
        { containerId: "plans", principalKind: "group", principalId: GROUP, permission: "edit" },
      ],
      groupMembers: [
        { groupId: GROUP, userId: MEMBER },
        { groupId: GROUP, userId: GUEST },
      ],
    });
    expect(permissionOn(rows, MEMBER, "plans")).toBe("edit");
    expect(permissionOn(rows, GUEST, "plans")).toBe("edit");
    expect(permissionOn(rows, LIMITED, "plans")).toBeNull();
  });

  it("to someone who is not in the workspace produces nothing", () => {
    // Removing a member must not require hunting down every grant they hold.
    const rows = resolve({
      grants: [
        { containerId: "plans", principalKind: "user", principalId: STRANGER, permission: "manage" },
      ],
    });
    expect(listsFor(rows, STRANGER)).toEqual([]);
  });

  it("to an empty group produces nothing", () => {
    const rows = resolve({
      grants: [
        { containerId: "plans", principalKind: "group", principalId: GROUP, permission: "manage" },
      ],
    });
    expect(rows.every((row) => row.containerId !== "plans" || row.principalId === OWNER)).toBe(true);
  });
});

describe("the strongest permission wins", () => {
  it("across two grants on different levels", () => {
    const rows = resolve({
      grants: [
        { containerId: "secret", principalKind: "user", principalId: GUEST, permission: "view" },
        { containerId: "plans", principalKind: "user", principalId: GUEST, permission: "manage" },
      ],
    });
    expect(permissionOn(rows, GUEST, "plans")).toBe("manage");
  });

  it("across a user grant and a group grant", () => {
    const rows = resolve({
      grants: [
        { containerId: "plans", principalKind: "user", principalId: GUEST, permission: "view" },
        { containerId: "plans", principalKind: "group", principalId: GROUP, permission: "edit" },
      ],
      groupMembers: [{ groupId: GROUP, userId: GUEST }],
    });
    expect(permissionOn(rows, GUEST, "plans")).toBe("edit");
  });

  it("regardless of the order they arrive in", () => {
    const weakFirst: AccessGrant[] = [
      { containerId: "plans", principalKind: "user", principalId: GUEST, permission: "view" },
      { containerId: "plans", principalKind: "user", principalId: GUEST, permission: "manage" },
    ];
    expect(permissionOn(resolve({ grants: weakFirst }), GUEST, "plans")).toBe("manage");
    expect(permissionOn(resolve({ grants: [...weakFirst].reverse() }), GUEST, "plans")).toBe(
      "manage",
    );
  });

  it("compares by rank, not alphabetically", () => {
    // "edit" < "manage" < "view" as strings, which is why this is a lookup.
    expect(strongest("view", "edit")).toBe("edit");
    expect(strongest("manage", "view")).toBe("manage");
    expect(strongest("comment", "comment")).toBe("comment");
  });
});

describe("the index itself", () => {
  it("holds every container kind, not only lists (D-108)", () => {
    // Task queries join the list rows; sharing and a space-scoped dashboard join
    // the rest, instead of falling back to a workspace role (D-081).
    expect(reachableFor(resolve(), MEMBER)).toEqual(["backlog", "folder", "space", "sprint"]);
  });

  it("is stable, so a rebuild that changes nothing produces the same rows", () => {
    expect(resolve()).toEqual(resolve());
  });

  it("has one row per user and container", () => {
    const rows = resolve({
      grants: [
        { containerId: "space", principalKind: "user", principalId: MEMBER, permission: "manage" },
        { containerId: "folder", principalKind: "user", principalId: MEMBER, permission: "view" },
      ],
    });
    const keys = rows.map((row) => `${row.principalId} ${row.containerId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("what a change forces a rebuild of", () => {
  it("is every container beneath the one that changed, itself included", () => {
    expect(affectedContainers("space", containers)).toEqual([
      "backlog",
      "folder",
      "space",
      "sprint",
    ]);
    expect(affectedContainers("folder", containers)).toEqual(["folder", "sprint"]);
    expect(affectedContainers("secret", containers)).toEqual(["plans", "secret"]);
  });

  it("is the container itself when it has nothing beneath it", () => {
    expect(affectedContainers("sprint", containers)).toEqual(["sprint"]);
  });

  it("is nothing for a container that no longer exists", () => {
    expect(affectedContainers("deleted", containers)).toEqual([]);
  });
});

describe("a container row", () => {
  it("gives a member of an open workspace their role's permission on a space", () => {
    // This is the row sharing needs: "may this person manage this space" is now
    // a question the index can answer (D-081).
    const rows = resolve();
    expect(permissionOn(rows, ADMIN, "space")).toBe("manage");
    expect(permissionOn(rows, MEMBER, "space")).toBe("edit");
    expect(permissionOn(rows, MEMBER, "folder")).toBe("edit");
    expect(permissionOn(rows, GUEST, "space")).toBeNull();
  });

  it("is absent for a private space nobody granted, and present for its owner", () => {
    const rows = resolve();
    expect(permissionOn(rows, ADMIN, "secret")).toBeNull();
    expect(permissionOn(rows, MEMBER, "secret")).toBeNull();
    expect(permissionOn(rows, OWNER, "secret")).toBe("manage");
  });

  it("lets a grant on a private space carry manage of the space itself", () => {
    // The D-081 case: a lead holding the space can share it without being a
    // workspace admin, because the permission is on the container.
    const rows = resolve({
      grants: [
        { containerId: "secret", principalKind: "user", principalId: MEMBER, permission: "manage" },
      ],
    });
    expect(permissionOn(rows, MEMBER, "secret")).toBe("manage");
    expect(permissionOn(rows, MEMBER, "plans")).toBe("manage");
  });

  it("does not appear for an ancestor just because a list below it was shared", () => {
    // Grants reach downward only. Being given one list inside a private space
    // must not confer anything on the space — see the note in access.ts.
    const rows = resolve({
      grants: [
        { containerId: "plans", principalKind: "user", principalId: GUEST, permission: "edit" },
      ],
    });
    expect(reachableFor(rows, GUEST)).toEqual(["plans"]);
    expect(permissionOn(rows, GUEST, "secret")).toBeNull();
  });
});

describe("whether a permission reaches what an action needs", () => {
  it("is true for the exact permission", () => {
    expect(satisfies("edit", "edit")).toBe(true);
    expect(satisfies("view", "view")).toBe(true);
  });

  it("is true for a stronger one", () => {
    expect(satisfies("manage", "view")).toBe(true);
    expect(satisfies("edit", "comment")).toBe(true);
    expect(satisfies("comment", "view")).toBe(true);
  });

  it("is false for a weaker one", () => {
    expect(satisfies("view", "edit")).toBe(false);
    expect(satisfies("comment", "edit")).toBe(false);
    expect(satisfies("edit", "manage")).toBe(false);
  });

  // The ladder read backwards is the failure mode this function exists to
  // prevent, so it is asserted in both directions rather than once.
  it("is not symmetric", () => {
    expect(satisfies("manage", "edit")).toBe(true);
    expect(satisfies("edit", "manage")).toBe(false);
  });
});
