import { describe, expect, it } from "vitest";

import { type ContainerNode, indexById } from "./hierarchy";
import {
  STATUS_TEMPLATES,
  type StatusDefinition,
  type StatusSetDefinition,
  StatusError,
  assertUsableStatusSet,
  canDeleteStatus,
  containersAffectedBy,
  planStatusDeletion,
  reorderStatuses,
  resolveStatusSet,
  statusTemplate,
} from "./statuses";

const SPACE = "space-1";
const FOLDER = "folder-1";
const LIST = "list-1";
const SIBLING = "list-2";

const tree: ContainerNode[] = [
  { id: SPACE, parentId: null, kind: "space", name: "Engineering", isPrivate: false },
  { id: FOLDER, parentId: SPACE, kind: "folder", name: "Platform", isPrivate: false },
  { id: LIST, parentId: FOLDER, kind: "list", name: "Sprint 24", isPrivate: false },
  { id: SIBLING, parentId: SPACE, kind: "list", name: "Backlog", isPrivate: false },
];

const containers = indexById(tree);

function status(
  id: string,
  name: string,
  group: StatusDefinition["group"],
  position: number,
): StatusDefinition {
  return { id, name, group, color: "#6B7686", position };
}

const workflow = [
  status("s1", "Todo", "not_started", 0),
  status("s2", "In Progress", "active", 1),
  status("s3", "Done", "done", 2),
];

function set(id: string, containerId: string | null): StatusSetDefinition {
  return { id, name: id, containerId, isTemplate: false, statuses: workflow };
}

describe("resolveStatusSet", () => {
  it("prefers a container's own set", () => {
    const sets = new Map([
      [SPACE, set("space-set", SPACE)],
      [LIST, set("list-set", LIST)],
    ]);
    const { set: resolved, source } = resolveStatusSet(LIST, containers, sets);
    expect(resolved.id).toBe("list-set");
    expect(source).not.toBe("workspace");
  });

  it("walks up to the nearest ancestor that defines one", () => {
    const sets = new Map([[SPACE, set("space-set", SPACE)]]);
    const { set: resolved, source } = resolveStatusSet(LIST, containers, sets);
    expect(resolved.id).toBe("space-set");
    // The UI says "inherited from Engineering" — it needs the container, not a
    // boolean.
    expect(source).not.toBe("workspace");
    expect(source === "workspace" ? null : source.name).toBe("Engineering");
  });

  it("falls back to the workspace default", () => {
    const { set: resolved, source } = resolveStatusSet(
      LIST,
      containers,
      new Map(),
      set("default", null),
    );
    expect(resolved.id).toBe("default");
    expect(source).toBe("workspace");
  });

  it("refuses to guess when nothing resolves", () => {
    expect(() => resolveStatusSet(LIST, containers, new Map())).toThrow(StatusError);
  });
});

describe("assertUsableStatusSet", () => {
  it("accepts an ordinary workflow", () => {
    expect(() => assertUsableStatusSet(workflow)).not.toThrow();
  });

  it("rejects a set where nothing can ever be finished", () => {
    expect(() =>
      assertUsableStatusSet([status("a", "Todo", "not_started", 0), status("b", "Doing", "active", 1)]),
    ).toThrow(/done or closed/);
  });

  it("rejects a set where everything starts finished", () => {
    expect(() => assertUsableStatusSet([status("a", "Done", "done", 0)])).toThrow(/open status/);
  });

  it("rejects duplicate names regardless of case", () => {
    expect(() =>
      assertUsableStatusSet([...workflow, status("s4", "todo", "active", 3)]),
    ).toThrow(/Duplicate status name/);
  });

  it("allows an unusual but answerable workflow", () => {
    // Six active columns and no `done` — unfamiliar, not broken.
    const unusual = [
      status("a", "Intake", "not_started", 0),
      status("b", "Triage", "active", 1),
      status("c", "Fixing", "active", 2),
      status("d", "Verifying", "active", 3),
      status("e", "Closed", "closed", 4),
    ];
    expect(() => assertUsableStatusSet(unusual)).not.toThrow();
  });
});

describe("canDeleteStatus", () => {
  it("refuses to remove the last way to finish work", () => {
    const verdict = canDeleteStatus(workflow, "s3");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/done or closed/);
  });

  it("allows removing one of several", () => {
    const wider = [...workflow, status("s4", "Shipped", "done", 3)];
    expect(canDeleteStatus(wider, "s3")).toEqual({ ok: true });
  });

  it("reports a status that is not in the set", () => {
    expect(canDeleteStatus(workflow, "nope").ok).toBe(false);
  });
});

describe("planStatusDeletion", () => {
  const wider = [...workflow, status("s4", "Shipped", "done", 3)];

  it("moves every affected task as its own invertible operation", () => {
    const plan = planStatusDeletion(wider, "s3", "s4", ["t1", "t2"]);
    expect(plan.movedTasks).toBe(2);
    expect(plan.operations).toEqual([
      { kind: "setField", taskId: "t1", field: "statusId", from: "s3", to: "s4" },
      { kind: "setField", taskId: "t2", field: "statusId", from: "s3", to: "s4" },
    ]);
  });

  it("plans nothing when no task used the status", () => {
    expect(planStatusDeletion(wider, "s3", "s4", []).operations).toEqual([]);
  });

  it("refuses a replacement from outside the set", () => {
    // Tasks would land on a status their list cannot display.
    expect(() => planStatusDeletion(wider, "s3", "elsewhere", ["t1"])).toThrow(/same set/);
  });

  it("refuses to replace a status with itself", () => {
    expect(() => planStatusDeletion(wider, "s3", "s3", ["t1"])).toThrow(StatusError);
  });

  it("refuses when the deletion would break the set", () => {
    expect(() => planStatusDeletion(workflow, "s3", "s1", ["t1"])).toThrow(/done or closed/);
  });
});

describe("reorderStatuses", () => {
  it("renumbers from zero with no gaps", () => {
    const moved = reorderStatuses(workflow, "s3", 0);
    expect(moved.map((s) => s.id)).toEqual(["s3", "s1", "s2"]);
    expect(moved.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it("rejects an index outside the set", () => {
    expect(() => reorderStatuses(workflow, "s1", 9)).toThrow(StatusError);
  });
});

describe("templates", () => {
  it("ships only workflows that pass the usability rules", () => {
    for (const template of STATUS_TEMPLATES) {
      const withIds = template.statuses.map((s, i) => ({ ...s, id: `${template.key}-${i}` }));
      expect(() => assertUsableStatusSet(withIds)).not.toThrow();
    }
  });

  it("keeps Blocked inside the active group rather than inventing a fifth", () => {
    const kanban = statusTemplate("kanban");
    expect(kanban.statuses.find((s) => s.name === "Blocked")?.group).toBe("active");
  });

  it("rejects an unknown key", () => {
    expect(() => statusTemplate("waterfall")).toThrow(StatusError);
  });
});

describe("containersAffectedBy", () => {
  it("counts descendants that inherit, so a settings screen can warn first", () => {
    const affected = containersAffectedBy(SPACE, containers, new Map());
    expect(affected.sort()).toEqual([FOLDER, LIST, SIBLING, SPACE].sort());
  });

  it("stops at a descendant that defines its own set", () => {
    const sets = new Map([[FOLDER, set("folder-set", FOLDER)]]);
    const affected = containersAffectedBy(SPACE, containers, sets);
    // The folder overrides, so neither it nor Sprint 24 beneath it changes.
    expect(affected.sort()).toEqual([SIBLING, SPACE].sort());
  });
});
