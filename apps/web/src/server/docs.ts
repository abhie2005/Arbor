import "server-only";

import {
  type DocRecord,
  containerAccess,
  listDocs,
  loadContainerTree,
  loadDoc,
  mentionableIn,
} from "@arbor/db";
import { cache } from "react";

/**
 * The docs screen's data.
 *
 * Two lists and one document. `listDocs` is already permission-scoped by the
 * `access_index` join (D-111), so the tree this builds contains only pages the
 * viewer can reach — there is no second filter here, and there must not be:
 * a screen that filtered again would be a second rule to keep in step.
 *
 * **Where a page may be created is a permission question**, so it is asked of
 * the index rather than of the container tree. A member sees every space in the
 * picker they hold `edit` on, which is the same permission adding a task to a
 * list takes.
 */

export interface DocPlace {
  id: string;
  name: string;
  kind: "space" | "folder" | "list";
  depth: number;
}

export interface DocsPage {
  docs: DocRecord[];
  places: DocPlace[];
  /** Null when the workspace has no documents, or the asked-for one is gone. */
  open: { doc: DocRecord; state: string } | null;
  canCreateWorkspaceWide: boolean;
  /**
   * Who the editor's `@` can mean — the workspace's members, loaded with the
   * page rather than fetched when somebody types. A workspace has hundreds of
   * people, not millions, and a picker that asked the server per keystroke
   * would be a round trip inside the one interaction that has to feel local.
   */
  people: { id: string; name: string }[];
}

export const loadDocsPage = cache(
  async (
    workspaceId: string,
    viewerId: string,
    docId: string | null,
    isAdmin: boolean,
  ): Promise<DocsPage> => {
    const [docs, containers, people] = await Promise.all([
      listDocs(workspaceId, viewerId),
      loadContainerTree(workspaceId),
      mentionableIn(workspaceId),
    ]);

    const nodes = [...containers.values()];
    const depthOf = (id: string): number => {
      let depth = 0;
      let current = containers.get(id)?.parentId ?? null;
      while (current && depth < 64) {
        depth += 1;
        current = containers.get(current)?.parentId ?? null;
      }
      return depth;
    };

    // One index lookup per container. A workspace has hundreds of these, not
    // millions, and asking the index is what makes the picker agree with what
    // the create action will actually allow.
    const holdings = await Promise.all(
      nodes.map(async (node) => ({ node, permission: await containerAccess(node.id, viewerId) })),
    );

    const places: DocPlace[] = holdings
      .filter(({ permission }) => permission === "edit" || permission === "manage")
      .map(({ node }) => ({
        id: node.id,
        name: node.name,
        kind: node.kind,
        depth: depthOf(node.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const asked = docId ?? docs[0]?.id ?? null;
    const open = asked ? await loadDoc(asked, viewerId) : null;

    return {
      docs,
      places,
      // Base64 because a server component hands this to the browser as JSON,
      // and a Uint8Array does not survive the trip — the same lesson an
      // operation learned the hard way (D-097).
      open: open ? { doc: open, state: Buffer.from(open.state).toString("base64") } : null,
      canCreateWorkspaceWide: isAdmin,
      people,
    };
  },
);
