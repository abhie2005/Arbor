import { ancestorsOf } from "@arbor/core";
import { listApiTokens, loadContainerTree, reachableContainers } from "@arbor/db";

import {
  ApiTokensPanel,
  type TokenContainer,
  type TokenRow,
} from "@/components/settings/api-tokens-panel";
import { requireUser } from "@/server/auth";
import { requireWorkspace } from "@/server/workspace";

export const dynamic = "force-dynamic";

/**
 * The API tokens screen (D-135).
 *
 * The endpoints have existed since D-133 and D-134 and the only token a person
 * could hold was the one the seed prints — which made the public API a thing
 * you could use if you had a shell on the database. This is the screen that was
 * owed, and it is the same shape as the automations one: the container tree
 * scoped by `reachableContainers(… "manage")`, because a token is minted
 * against a container and `manage` is what minting one takes.
 *
 * **It lists the tokens whose container the viewer manages, not the
 * workspace's** (D-123). A token names a container; somebody who cannot manage
 * that container cannot revoke the token and has no business being told it
 * exists.
 */
export default async function ApiTokensPage() {
  const workspace = await requireWorkspace();
  const viewer = await requireUser();

  const tree = await loadContainerTree(workspace.id);
  const manageable = await reachableContainers(workspace.id, viewer.id, "manage");
  const nodes = [...tree.values()];

  // Depth-first, so the picker reads as the tree it is.
  const ordered: typeof nodes = [];
  const walk = (parentId: string | null) => {
    for (const node of nodes
      .filter((candidate) => candidate.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      ordered.push(node);
      walk(node.id);
    }
  };
  walk(null);

  const containers: TokenContainer[] = ordered
    .filter((node) => manageable.has(node.id))
    .map((node) => ({
      id: node.id,
      name: node.name,
      kind: node.kind,
      // Only ancestors that are themselves on screen, so the indentation
      // describes what is listed rather than the tree behind it.
      depth: ancestorsOf(node.id, tree).filter(
        (ancestor) => ancestor.id !== node.id && manageable.has(ancestor.id),
      ).length,
    }));

  const tokens: TokenRow[] = (await listApiTokens(workspace.id))
    .filter((token) => manageable.has(token.containerId))
    .map((token) => ({
      id: token.id,
      name: token.name,
      prefix: token.prefix,
      containerId: token.containerId,
      containerName: tree.get(token.containerId)?.name ?? "a container you cannot see",
      // ISO across the boundary, rendered by `Timestamp` (D-121, D-097).
      createdAt: token.createdAt.toISOString(),
      lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
      expiresAt: token.expiresAt?.toISOString() ?? null,
      revokedAt: token.revokedAt?.toISOString() ?? null,
    }));

  return (
    <>
      <header className="header">
        <div className="crumb">
          Settings<span>&#8250;</span>
          <strong>API tokens</strong>
        </div>
      </header>

      <div className="settings-body">
        <p className="settings-note">
          A token is a bearer credential for <code>/api/v1</code>. It speaks as a service account
          of its own rather than as you, so what it writes is attributable to the integration, and
          it reaches the one container it was minted against and nothing else. Reads are{" "}
          <code>POST /api/v1/views/query</code> with a view definition; writes are{" "}
          <code>POST /api/v1/operations</code> with the operations the app itself uses.
        </p>

        <ApiTokensPanel containers={containers} tokens={tokens} />
      </div>
    </>
  );
}
