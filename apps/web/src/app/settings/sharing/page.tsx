import { ancestorsOf, isEffectivelyPrivate } from "@arbor/core";
import { listGrants, loadContainerTree, pool } from "@arbor/db";

import {
  type ContainerSummary,
  SharingPanel,
  type Principal,
} from "@/components/settings/sharing-panel";
import { requireWorkspace } from "@/server/workspace";

export const dynamic = "force-dynamic";

/**
 * Who can reach what.
 *
 * The screen ADR 3 implies and nothing exposed until now: grants are the source
 * of truth, and this is where they are written. The number beside each
 * container is read from the access index rather than counted from its grants,
 * because the index is the thing queries actually use — if the two ever
 * disagree, this screen shows the truth rather than the intention.
 */
export default async function SharingPage({
  searchParams,
}: {
  searchParams: Promise<{ container?: string }>;
}) {
  const { container } = await searchParams;
  const workspace = await requireWorkspace();

  const tree = await loadContainerTree(workspace.id);
  const nodes = [...tree.values()];

  // Depth-first, so the list reads as the tree it is.
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

  const reachRows = await pool().query<{ container_id: string; reach: string }>(
    `SELECT c.id AS container_id, COUNT(DISTINCT ai.principal_id) AS reach
     FROM containers c
     LEFT JOIN access_index ai ON ai.list_id = c.id
     WHERE c.workspace_id = $1
     GROUP BY c.id`,
    [workspace.id],
  );
  const reachByList = new Map(reachRows.rows.map((row) => [row.container_id, Number(row.reach)]));

  // A space's reach is the people who can see anything inside it, which is the
  // union over its lists — not a number the index holds directly.
  const listsUnder = (id: string): string[] =>
    nodes
      .filter((node) => node.parentId === id)
      .flatMap((node) => (node.kind === "list" ? [node.id] : listsUnder(node.id)));

  const summaries: ContainerSummary[] = ordered.map((node) => ({
    id: node.id,
    name: node.name,
    kind: node.kind,
    depth: ancestorsOf(node.id, tree).length - 1,
    isPrivate: node.isPrivate,
    inheritsPrivacy: isEffectivelyPrivate(node.id, tree) && !node.isPrivate,
    reach:
      node.kind === "list"
        ? (reachByList.get(node.id) ?? 0)
        : Math.max(0, ...listsUnder(node.id).map((listId) => reachByList.get(listId) ?? 0)),
  }));

  const selected = summaries.find((node) => node.id === container) ?? summaries[0] ?? null;

  const [grants, users, groups] = await Promise.all([
    selected ? listGrants(selected.id) : Promise.resolve([]),
    pool().query<{ id: string; name: string }>(
      `SELECT u.id, u.name FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.workspace_id = $1
       WHERE u.deactivated_at IS NULL ORDER BY u.name`,
      [workspace.id],
    ),
    pool().query<{ id: string; name: string }>(
      `SELECT id, name FROM user_groups WHERE workspace_id = $1 ORDER BY name`,
      [workspace.id],
    ),
  ]);

  const principals: Principal[] = [
    ...users.rows.map((row) => ({ id: row.id, name: row.name, kind: "user" as const })),
    ...groups.rows.map((row) => ({ id: row.id, name: row.name, kind: "group" as const })),
  ];

  return (
    <>
      <header className="header">
        <div className="crumb">
          Settings<span>&#8250;</span>
          <strong>Sharing</strong>
        </div>
      </header>

      <div className="settings-body">
        <p className="settings-note">
          Grants are the source of truth; the number beside each container is how many people the
          access index says can reach it. A private container is reachable only through a grant on
          it or above it — the workspace owner excepted, who can always reach everything.
        </p>

        <SharingPanel
          containers={summaries}
          selected={selected}
          grants={grants}
          principals={principals}
        />
      </div>
    </>
  );
}
