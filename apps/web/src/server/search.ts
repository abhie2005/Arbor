import "server-only";

import {
  type DocHit,
  loadContainerTree,
  loadFieldCatalog,
  pool,
  searchDocs,
} from "@arbor/db";
import {
  DEFAULT_VIEW_DEFINITION,
  type Snippet,
  compileViewQuery,
  snippet,
} from "@arbor/core";
import { cache } from "react";

/**
 * The search screen's data: two halves, each through the path that already
 * knows who may read what.
 *
 * **The task half is a compiled view** (invariant 2, D-032). `filters.search`
 * has existed in the compiler since the beginning and nothing ever set it; this
 * sets it, with scope `everything`, and gets the `access_index` join for free.
 * There is no SQL in this file for tasks, and there must not be — a screen with
 * its own task query is the bet the compiler exists to win.
 *
 * **The doc half is `searchDocs`**, which shares its reachability clause with
 * `listDocs` for the same reason (D-111). Documents never went through the
 * compiler: it compiles a definition over `tasks`, and a page is not a task.
 *
 * **Two queries, not one `UNION`.** They are different shapes — a task has a
 * status and a key, a document has a snippet — and a union would have to widen
 * both to the other's columns and then sort a result set whose two halves have
 * no comparable rank. Ranking across the halves is a product decision, and the
 * decision made here is not to: the screen shows tasks and documents in
 * separate sections, so nothing has to claim a task is a better match than a
 * page (D-113).
 */

export interface TaskHit {
  id: string;
  key: string | null;
  name: string;
  statusId: string | null;
  statusGroup: string | null;
  /** "Engineering › Platform › Sprint 24", resolved from the container tree. */
  path: string;
}

export interface DocResult {
  id: string;
  title: string;
  containerName: string | null;
  updatedAt: Date;
  titleMatched: boolean;
  /** Null when the document has no text yet — a page created and not written in. */
  snippet: Snippet | null;
}

export interface SearchResults {
  term: string;
  tasks: TaskHit[];
  docs: DocResult[];
  statuses: { id: string; name: string; color: string }[];
  /** True when a half hit its limit, so the screen can say the list is cut off. */
  taskLimitHit: boolean;
  docLimitHit: boolean;
}

const TASK_LIMIT = 25;
const DOC_LIMIT = 25;

export const loadSearch = cache(
  async (workspaceId: string, viewerId: string, term: string): Promise<SearchResults> => {
    const connection = pool();

    const [taskRows, docHits, containers, statuses] = await Promise.all([
      runTaskSearch(workspaceId, viewerId, term, connection),
      searchDocs(workspaceId, viewerId, term, DOC_LIMIT, connection),
      loadContainerTree(workspaceId, connection),
      // Statuses hang off a status *set*, and the set is what belongs to a
      // workspace — `statuses` has no `workspace_id`. Same join
      // `loadFilterOptions` uses (`server/views.ts`), because there is one
      // right answer to "this workspace's statuses" and this is it.
      connection.query<{ id: string; name: string; color: string }>(
        `SELECT st.id, st.name, st.color
           FROM statuses st
           JOIN status_sets ss ON ss.id = st.status_set_id
          WHERE ss.workspace_id = $1`,
        [workspaceId],
      ),
    ]);

    // The path is built from the tree rather than joined in the query, because
    // the compiler's SELECT list is fixed and a renderer does not get to add to
    // it. A workspace has hundreds of containers, and this map is one query.
    const pathOf = (listId: string | null): string => {
      const parts: string[] = [];
      let current = listId;
      for (let depth = 0; current && depth < 64; depth += 1) {
        const node = containers.get(current);
        if (!node) break;
        parts.unshift(node.name);
        current = node.parentId;
      }
      return parts.join(" › ");
    };

    return {
      term,
      tasks: taskRows.map((row) => ({
        id: row.id,
        key: row.key,
        name: row.name,
        statusId: row.status_id,
        statusGroup: row.status_group,
        path: pathOf(row.home_list_id),
      })),
      docs: docHits.map(toDocResult(term)),
      statuses: statuses.rows,
      taskLimitHit: taskRows.length === TASK_LIMIT,
      docLimitHit: docHits.length === DOC_LIMIT,
    };
  },
);

interface TaskSearchRow {
  id: string;
  key: string | null;
  name: string;
  status_id: string | null;
  status_group: string | null;
  home_list_id: string | null;
}

/**
 * The compiler, asked for everything the viewer can reach whose name matches.
 *
 * `showClosed` is true, unlike a list view's default. A search is a lookup, not
 * a work queue: somebody typing a task's name is looking for *that task*, and
 * hiding it because it is Done would read as the search being broken. The same
 * reasoning makes subtasks mode 1 — a subtask is a result in its own right
 * here, rather than a row that only makes sense under its parent.
 */
async function runTaskSearch(
  workspaceId: string,
  viewerId: string,
  term: string,
  connection: ReturnType<typeof pool>,
): Promise<TaskSearchRow[]> {
  const fields = await loadFieldCatalog(workspaceId, connection);

  const compiled = compileViewQuery({
    workspaceId,
    viewerId,
    scope: { kind: "everything" },
    definition: {
      ...DEFAULT_VIEW_DEFINITION,
      grouping: { field: "none", dir: "asc" },
      // Most recently touched first. The compiler has no relevance score to
      // sort by — matching is `ILIKE`, which is a yes or a no (D-113) — and
      // recency is the tiebreaker a person can predict.
      sort: [{ field: "updatedAt", dir: "desc" }],
      filters: {
        op: "AND",
        conditions: [],
        search: term,
        showClosed: true,
        showSubtasks: 1,
      },
    },
    fields,
    limit: TASK_LIMIT,
  });

  const result = await connection.query<TaskSearchRow>(compiled.text, compiled.params);
  return result.rows;
}

function toDocResult(term: string) {
  return (hit: DocHit): DocResult => ({
    id: hit.id,
    title: hit.title,
    containerName: hit.containerName,
    updatedAt: hit.updatedAt,
    titleMatched: hit.titleMatched,
    snippet: hit.searchText ? snippet(hit.searchText, term) : null,
  });
}
