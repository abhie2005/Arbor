/**
 * Configuration inheritance.
 *
 * A list's effective status set is its own, else its nearest ancestor's, else
 * the workspace default. The same walk answers "which custom fields apply here"
 * and "is this container private". Resolving it once, here, is what stops the
 * rule from being reimplemented slightly differently in a dozen call sites.
 */

export type ContainerKind = "space" | "folder" | "list";

export interface ContainerNode {
  id: string;
  parentId: string | null;
  kind: ContainerKind;
  name: string;
  isPrivate: boolean;
}

export class HierarchyError extends Error {}

/** Depth guard — a cycle in the tree would otherwise hang the walk. */
const MAX_DEPTH = 64;

/**
 * The chain from a container up to its root space, nearest first.
 * `ancestorsOf(list)` returns `[list, folder, space]`.
 */
export function ancestorsOf(
  containerId: string,
  byId: ReadonlyMap<string, ContainerNode>,
): ContainerNode[] {
  const chain: ContainerNode[] = [];
  let current = byId.get(containerId);
  let depth = 0;

  while (current) {
    if (depth++ > MAX_DEPTH) {
      throw new HierarchyError(`Container tree exceeds ${MAX_DEPTH} levels at ${containerId} — cycle?`);
    }
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  if (chain.length === 0) {
    throw new HierarchyError(`Container not found: ${containerId}`);
  }

  return chain;
}

/**
 * Walk up until a container defines the setting. Returns the value and which
 * container supplied it, because the UI needs to say "inherited from Engineering".
 */
export function resolveInherited<T>(
  containerId: string,
  byId: ReadonlyMap<string, ContainerNode>,
  definedAt: (container: ContainerNode) => T | undefined,
): { value: T; source: ContainerNode } | undefined {
  for (const node of ancestorsOf(containerId, byId)) {
    const value = definedAt(node);
    if (value !== undefined) return { value, source: node };
  }
  return undefined;
}

/**
 * Effective privacy: a container is private if it or any ancestor is.
 * Tightening at any level is allowed; loosening below a private ancestor is not.
 */
export function isEffectivelyPrivate(
  containerId: string,
  byId: ReadonlyMap<string, ContainerNode>,
): boolean {
  return ancestorsOf(containerId, byId).some((node) => node.isPrivate);
}

/** The root space a container belongs to. */
export function spaceOf(
  containerId: string,
  byId: ReadonlyMap<string, ContainerNode>,
): ContainerNode {
  const chain = ancestorsOf(containerId, byId);
  const space = chain[chain.length - 1];
  if (!space || space.kind !== "space") {
    throw new HierarchyError(`Container ${containerId} does not descend from a space`);
  }
  return space;
}

/**
 * The denormalized ancestor ids stored on every task. Recomputed whenever a
 * task or one of its containers moves; keeping them correct is what lets
 * cross-container views skip the recursive CTE.
 */
export function denormalizedAncestors(
  listId: string,
  byId: ReadonlyMap<string, ContainerNode>,
): { spaceId: string; folderId: string | null } {
  const chain = ancestorsOf(listId, byId);
  const list = chain[0];

  if (!list || list.kind !== "list") {
    throw new HierarchyError(`${listId} is not a list`);
  }

  const space = chain[chain.length - 1];
  if (!space || space.kind !== "space") {
    throw new HierarchyError(`List ${listId} does not descend from a space`);
  }

  // The folder directly containing the list, if any. Deeper subfolders still
  // report their nearest folder, which is what filters expect.
  const folder = chain.find((node) => node.kind === "folder") ?? null;

  return { spaceId: space.id, folderId: folder?.id ?? null };
}

/** Every descendant id of a container, including itself. */
export function subtreeIds(
  rootId: string,
  byId: ReadonlyMap<string, ContainerNode>,
): string[] {
  const childrenByParent = new Map<string, ContainerNode[]>();
  for (const node of byId.values()) {
    if (!node.parentId) continue;
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }

  const out: string[] = [];
  const stack = [rootId];
  let visited = 0;

  while (stack.length > 0) {
    const id = stack.pop();
    if (!id) break;
    if (visited++ > byId.size + 1) {
      throw new HierarchyError("Cycle detected while walking container subtree");
    }
    out.push(id);
    for (const child of childrenByParent.get(id) ?? []) stack.push(child.id);
  }

  return out;
}

/**
 * Reject a move that would put a container inside its own subtree. Cheap to
 * check, and the resulting cycle is very unpleasant to debug in production.
 */
export function assertMoveIsLegal(
  containerId: string,
  newParentId: string | null,
  byId: ReadonlyMap<string, ContainerNode>,
): void {
  if (newParentId === null) return;
  if (containerId === newParentId) {
    throw new HierarchyError("A container cannot be its own parent");
  }
  if (subtreeIds(containerId, byId).includes(newParentId)) {
    throw new HierarchyError("Cannot move a container inside its own subtree");
  }
}

export function indexById(nodes: readonly ContainerNode[]): Map<string, ContainerNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}
