import { describe, expect, it } from "vitest";

import {
  HierarchyError,
  type ContainerNode,
  ancestorsOf,
  assertMoveIsLegal,
  denormalizedAncestors,
  indexById,
  isEffectivelyPrivate,
  resolveInherited,
  subtreeIds,
} from "./hierarchy";

function node(
  id: string,
  kind: ContainerNode["kind"],
  parentId: string | null,
  isPrivate = false,
): ContainerNode {
  return { id, kind, parentId, name: id, isPrivate };
}

// space "eng"
//   folder "team"
//     subfolder "squad"          ← arbitrary depth, not a special case
//       list "sprint"
//   list "backlog"               ← folderless list, directly in the space
const TREE = indexById([
  node("eng", "space", null),
  node("team", "folder", "eng"),
  node("squad", "folder", "team"),
  node("sprint", "list", "squad"),
  node("backlog", "list", "eng"),
]);

describe("ancestorsOf", () => {
  it("returns the chain nearest-first up to the space", () => {
    expect(ancestorsOf("sprint", TREE).map((n) => n.id)).toEqual([
      "sprint",
      "squad",
      "team",
      "eng",
    ]);
  });

  it("handles a folderless list", () => {
    expect(ancestorsOf("backlog", TREE).map((n) => n.id)).toEqual(["backlog", "eng"]);
  });

  it("throws for an unknown container", () => {
    expect(() => ancestorsOf("nope", TREE)).toThrow(HierarchyError);
  });

  it("refuses to loop forever on a cycle", () => {
    const cyclic = indexById([node("a", "folder", "b"), node("b", "folder", "a")]);
    expect(() => ancestorsOf("a", cyclic)).toThrow(/cycle/i);
  });
});

describe("resolveInherited", () => {
  const statusSets = new Map([
    ["eng", "space-default"],
    ["squad", "squad-override"],
  ]);
  const definedAt = (c: ContainerNode) => statusSets.get(c.id);

  it("prefers the nearest ancestor that defines the value", () => {
    const resolved = resolveInherited("sprint", TREE, definedAt);
    expect(resolved?.value).toBe("squad-override");
    expect(resolved?.source.id).toBe("squad");
  });

  it("falls back to the space", () => {
    const resolved = resolveInherited("backlog", TREE, definedAt);
    expect(resolved?.value).toBe("space-default");
    expect(resolved?.source.id).toBe("eng");
  });

  it("returns undefined when nothing in the chain defines it", () => {
    expect(resolveInherited("sprint", TREE, () => undefined)).toBeUndefined();
  });
});

describe("isEffectivelyPrivate", () => {
  it("inherits privacy from any ancestor", () => {
    const tree = indexById([
      node("eng", "space", null, true),
      node("team", "folder", "eng"),
      node("sprint", "list", "team"),
    ]);
    expect(isEffectivelyPrivate("sprint", tree)).toBe(true);
  });

  it("is false when nothing in the chain is private", () => {
    expect(isEffectivelyPrivate("sprint", TREE)).toBe(false);
  });
});

describe("denormalizedAncestors", () => {
  it("finds the space and the nearest folder for a deeply nested list", () => {
    expect(denormalizedAncestors("sprint", TREE)).toEqual({
      spaceId: "eng",
      folderId: "squad",
    });
  });

  it("reports a null folder for a folderless list", () => {
    expect(denormalizedAncestors("backlog", TREE)).toEqual({
      spaceId: "eng",
      folderId: null,
    });
  });

  it("rejects a container that is not a list", () => {
    expect(() => denormalizedAncestors("team", TREE)).toThrow(/not a list/);
  });
});

describe("subtreeIds", () => {
  it("includes the root and every descendant", () => {
    expect(subtreeIds("team", TREE).sort()).toEqual(["sprint", "squad", "team"]);
  });

  it("returns just the node for a leaf", () => {
    expect(subtreeIds("backlog", TREE)).toEqual(["backlog"]);
  });
});

describe("assertMoveIsLegal", () => {
  it("allows a move to an unrelated container", () => {
    expect(() => assertMoveIsLegal("squad", "eng", TREE)).not.toThrow();
  });

  it("allows detaching to the root", () => {
    expect(() => assertMoveIsLegal("squad", null, TREE)).not.toThrow();
  });

  it("rejects a container becoming its own parent", () => {
    expect(() => assertMoveIsLegal("team", "team", TREE)).toThrow(HierarchyError);
  });

  it("rejects a move into its own subtree", () => {
    expect(() => assertMoveIsLegal("team", "sprint", TREE)).toThrow(/own subtree/);
  });
});
