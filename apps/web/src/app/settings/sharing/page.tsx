import { ancestorsOf, isEffectivelyPrivate } from "@arbor/core";
import { listGrants, loadContainerTree, pool, reachableContainers } from "@arbor/db";

import {
  type ContainerSummary,
  SharingPanel,
  type Principal,
} from "@/components/settings/sharing-panel";
import { requireUser } from "@/server/auth";
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
 *
 * **It lists what the viewer may share, not what exists** (D-123). It used to
 * list every container in the workspace with how many people reach each one, to
 * anybody who opened it — so a private space nobody had been shown was named
 * here, along with the size of the group that could see inside it. The actions
 * were already scoped to `manage` on the container (D-109); only the page was
 * not, which made it the one read in the app that did not join the access index
 * (invariant 5).
 *
 * **`manage`, the same thing the actions take**, because every control on this
 * screen is one of those actions. Listing a container you can see but not share
 * would be a row whose every button refuses.
 *
 * The *tree* is still loaded whole, and that is not the same leak: privacy
 * inheritance is a question about ancestors, so deciding whether a list you
 * manage sits inside a private space means knowing about that space. What
 * reaches the client is the filtered set.
 */
export default async function SharingPage({
  searchParams,
}: {
  searchParams: Promise<{ container?: string }>;
}) {
  const { container } = await searchParams;
  const workspace = await requireWorkspace();
  const viewer = await requireUser();

  const tree = await loadContainerTree(workspace.id);
  const nodes = [...tree.values()];

  // What this viewer may share. Everything below is filtered through it.
  const manageable = await reachableContainers(workspace.id, viewer.id, "manage");

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
     LEFT JOIN access_index ai ON ai.container_id = c.id
     WHERE c.workspace_id = $1
     GROUP BY c.id`,
    [workspace.id],
  );
  const reachByList = new Map(reachRows.rows.map((row) => [row.container_id, Number(row.reach)]));

  // A space's reach is the people who can see anything inside it, which is still
  // the union over its lists. The index holds a row for the space itself now
  // (D-108), and it is deliberately not this number: it says who may act on the
  // space, and somebody granted one list inside a private space sees something
  // in there without holding the space.
  const listsUnder = (id: string): string[] =>
    nodes
      .filter((node) => node.parentId === id)
      .flatMap((node) => (node.kind === "list" ? [node.id] : listsUnder(node.id)));

  const summaries: ContainerSummary[] = ordered
    .filter((node) => manageable.has(node.id))
    .map((node) => ({
      id: node.id,
      name: node.name,
      kind: node.kind,
      // Ancestors the viewer also manages, so the indentation is a tree of what
      // is on screen. Counting all of them would indent a list two steps under
      // a space that is not listed, which reads as a rendering bug.
      depth: ancestorsOf(node.id, tree).filter(
        (ancestor) => ancestor.id !== node.id && manageable.has(ancestor.id),
      ).length,
      isPrivate: node.isPrivate,
      inheritsPrivacy: isEffectivelyPrivate(node.id, tree) && !node.isPrivate,
      reach:
        node.kind === "list"
          ? (reachByList.get(node.id) ?? 0)
          : Math.max(0, ...listsUnder(node.id).map((listId) => reachByList.get(listId) ?? 0)),
    }));

  // A container named in the URL is only honoured if it is one of these — a
  // link to a space somebody cannot share falls back rather than refusing,
  // because a refusal that differs from "no such container" would say which
  // of the two it was (invariant 6).
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
