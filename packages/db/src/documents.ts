import {
  DocumentError,
  applyDocUpdate,
  docStateFromText,
  emptyDocState,
  escapeLike,
  positionBetween,
  richTextFrom,
  searchTextFrom,
} from "@arbor/core";
import type { Pool, PoolClient } from "pg";

import { pool } from "./client";
import { type ConfigContext, ConfigError, inTransaction, logConfigChange, requireName } from "./config";
import { announceChange } from "./live";

/**
 * Documents: the page tree, and the bytes each page is.
 *
 * **Two kinds of write, on purpose.** A document's *body* is a CRDT and arrives
 * as Yjs updates (ADR 6): they are merged and stored, and they are not
 * operations. A document's *place* — its title, its parent, its container, its
 * archived flag — is configuration, and follows `goals.ts` and `statuses.ts`
 * rather than `applyOperations`.
 *
 * **Why the lifecycle is not an operation** (D-111). Every operation carries a
 * `taskId`, because that is what `undo` authorizes a client-supplied batch
 * against (D-080), and a document has a container instead. That was also true
 * of goals (D-103). But the deciding reason here is ⌘Z itself: inside a
 * document, undo has to mean *the text I just typed*, which is the editor's own
 * history and not a workspace-wide stack. Two undo stacks fighting over one
 * keystroke is worse than a rename that is not undoable, and the activity row
 * — which is what makes a change accountable — is written either way.
 *
 * **Reads join `access_index`** like every other read (ADR 3, invariant 5). A
 * doc hangs off any container, which is a question the index could not answer
 * until it held container rows (D-108); docs are the first reader of that.
 */

type Connection = Pool | PoolClient;

/**
 * A document's state is capped.
 *
 * A CRDT only grows: every edit adds to the history, and nothing garbage-
 * collects a document nobody is editing any more. A megabyte is a very long
 * page and a refusal is recoverable, where an unbounded column is a row that
 * eventually cannot be read at all. When this bites, the answer is `Y.encodeStateAsUpdate`
 * over a fresh document to drop the tombstones, not a bigger number.
 */
const MAX_STATE_BYTES = 1_000_000;

export interface DocRecord {
  id: string;
  workspaceId: string;
  containerId: string | null;
  containerName: string | null;
  parentPageId: string | null;
  title: string;
  position: string;
  searchText: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

/** A document plus its bytes, which only an editor and the projection need. */
export interface DocWithState extends DocRecord {
  state: Uint8Array;
}

interface DocRow {
  id: string;
  workspace_id: string;
  container_id: string | null;
  container_name: string | null;
  parent_page_id: string | null;
  title: string;
  position: string;
  search_text: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

function toRecord(row: DocRow): DocRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    containerId: row.container_id,
    containerName: row.container_name,
    parentPageId: row.parent_page_id,
    title: row.title,
    position: row.position,
    searchText: row.search_text ?? "",
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

/**
 * The reachability clause, written once.
 *
 * A doc on a container needs a row in the index for that container. A doc with
 * **no** container is workspace-wide and readable by every member, which is the
 * same rule a workspace-wide saved view and a workspace-wide dashboard follow
 * (D-057, D-105) — there is no smaller thing to scope it to.
 */
const REACHABLE = `(
  d.container_id IS NULL
  OR EXISTS (
    SELECT 1 FROM access_index ax
    WHERE ax.container_id = d.container_id AND ax.principal_id = $2
  )
)`;

const SELECT_DOC = `SELECT d.id, d.workspace_id, d.container_id, c.name AS container_name,
        d.parent_page_id, d.title, d.position, d.search_text,
        d.created_by, d.created_at, d.updated_at, d.archived_at
   FROM docs d
   LEFT JOIN containers c ON c.id = d.container_id`;

/**
 * Every document in a workspace the viewer can reach, newest tree first.
 *
 * Ordered by container then position, so a caller can build the tree by walking
 * the list once rather than sorting siblings itself.
 */
export async function listDocs(
  workspaceId: string,
  viewerId: string,
  options: { includeArchived?: boolean } = {},
  connection: Connection = pool(),
): Promise<DocRecord[]> {
  const result = await connection.query<DocRow>(
    `${SELECT_DOC}
      WHERE d.workspace_id = $1
        AND ${REACHABLE}
        ${options.includeArchived ? "" : "AND d.archived_at IS NULL"}
      ORDER BY d.container_id NULLS FIRST, d.position, d.created_at`,
    [workspaceId, viewerId],
  );

  return result.rows.map(toRecord);
}

/** A document that matched a search, with the text that matched it. */
export interface DocHit extends DocRecord {
  /** True when the title matched, which is why the row sorts where it does. */
  titleMatched: boolean;
}

/**
 * Documents in this workspace whose title or text matches `term`.
 *
 * **The reachability clause is the same one `listDocs` uses**, which is the
 * whole reason search did not need a permission rule of its own: a doc on a
 * container needs a row in the index for it, a doc on no container is
 * workspace-wide (D-111). A search that filtered its own results afterwards
 * would be a second rule to keep in step, and the one that forgets.
 *
 * **`ILIKE`, not `to_tsquery`** (D-113). The view compiler already matches
 * `filters.search` with `ILIKE`, and one search box cannot have two notions of
 * what matches — a query that found a task and not an equally matching document
 * would read as a missing document. The cost is no ranking from Postgres, so
 * the order is decided here instead: a title match first, then most recently
 * edited.
 *
 * **Archived pages are excluded**, following `listDocs`. An archived page is
 * reachable by asking for it, and surfacing one in a search of live content
 * would make "archived" mean nothing.
 */
export async function searchDocs(
  workspaceId: string,
  viewerId: string,
  term: string,
  limit = 20,
  connection: Connection = pool(),
): Promise<DocHit[]> {
  // `$2` is the viewer, because REACHABLE says so — the clause is shared text
  // and its parameter positions come with it.
  const like = `%${escapeLike(term)}%`;

  const result = await connection.query<DocRow & { title_matched: boolean }>(
    `${SELECT_DOC.replace("d.archived_at", "d.archived_at, (d.title ILIKE $3) AS title_matched")}
      WHERE d.workspace_id = $1
        AND ${REACHABLE}
        AND d.archived_at IS NULL
        AND (d.title ILIKE $3 OR d.search_text ILIKE $3)
      ORDER BY (d.title ILIKE $3) DESC, d.updated_at DESC
      LIMIT $4`,
    [workspaceId, viewerId, like, limit],
  );

  return result.rows.map((row) => ({ ...toRecord(row), titleMatched: row.title_matched }));
}

/**
 * One document, or null when the viewer cannot reach it.
 *
 * Null covers "no such document" and "not yours" in one answer, for the reason
 * `taskAccess` does (invariant 6): a check that distinguishes them is an
 * existence oracle.
 */
export async function loadDoc(
  docId: string,
  viewerId: string,
  connection: Connection = pool(),
): Promise<DocWithState | null> {
  const result = await connection.query<DocRow & { ydoc: Buffer | null }>(
    `${SELECT_DOC.replace("d.archived_at", "d.archived_at, d.ydoc")}
      WHERE d.id = $1 AND ${REACHABLE}`,
    [docId, viewerId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    ...toRecord(row),
    // A row whose bytes are missing reads as an empty document rather than as a
    // failure: `ydoc` is nullable and always has been.
    state: row.ydoc ? new Uint8Array(row.ydoc) : emptyDocState(),
  };
}

export interface CreateDocInput {
  workspaceId: string;
  /** Null for a workspace-wide document. */
  containerId: string | null;
  parentPageId?: string | null;
  title: string;
  /** A first draft, parsed with the same rules a comment is (D-083). */
  text?: string;
}

export async function createDoc(input: CreateDocInput, context: ConfigContext): Promise<DocRecord> {
  const title = requireName(input.title, "A document title");

  return inTransaction(context, async (client) => {
    const parentPageId = input.parentPageId ?? null;
    if (parentPageId) await requireSameWorkspace(client, parentPageId, input.workspaceId);

    const state = input.text
      ? docStateFromText(input.text, await mentionable(client, input.workspaceId))
      : emptyDocState();
    const position = await nextPosition(client, input.containerId, parentPageId);

    const result = await client.query<DocRow>(
      `INSERT INTO docs
         (workspace_id, container_id, parent_page_id, title, ydoc, search_text, position, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, workspace_id, container_id, NULL::text AS container_name, parent_page_id,
                 title, position, search_text, created_by, created_at, updated_at, archived_at`,
      [
        input.workspaceId,
        input.containerId,
        parentPageId,
        title,
        Buffer.from(state),
        searchTextFrom(state),
        position,
        context.actorId,
      ],
    );

    const row = result.rows[0];
    if (!row) throw new ConfigError("The document could not be created");

    await logConfigChange(client, {
      workspaceId: input.workspaceId,
      actorId: context.actorId,
      objectKind: "doc",
      objectId: row.id,
      verb: "doc.created",
      field: "title",
      oldValue: null,
      newValue: title,
    });

    await announce(client, input.workspaceId, input.containerId, row.id, context.actorId);

    return toRecord(row);
  });
}

export async function renameDoc(
  docId: string,
  title: string,
  context: ConfigContext,
): Promise<void> {
  const next = requireName(title, "A document title");

  await inTransaction(context, async (client) => {
    const previous = await one(client, docId);

    if (previous.title === next) return;

    await client.query(`UPDATE docs SET title = $2, updated_at = now() WHERE id = $1`, [
      docId,
      next,
    ]);

    await logConfigChange(client, {
      workspaceId: previous.workspace_id,
      actorId: context.actorId,
      objectKind: "doc",
      objectId: docId,
      verb: "doc.renamed",
      field: "title",
      oldValue: previous.title,
      newValue: next,
    });

    await announce(client, previous.workspace_id, previous.container_id, docId, context.actorId);
  });
}

/**
 * Archived, never deleted — D-015, and more pointedly than usual: a document is
 * the one thing in the product somebody may have spent an afternoon writing.
 */
export async function archiveDoc(
  docId: string,
  archived: boolean,
  context: ConfigContext,
): Promise<void> {
  await inTransaction(context, async (client) => {
    const previous = await one(client, docId);
    if ((previous.archived_at !== null) === archived) return;

    await client.query(
      `UPDATE docs SET archived_at = ${archived ? "now()" : "NULL"}, updated_at = now()
       WHERE id = $1`,
      [docId],
    );

    await logConfigChange(client, {
      workspaceId: previous.workspace_id,
      actorId: context.actorId,
      objectKind: "doc",
      objectId: docId,
      verb: archived ? "doc.archived" : "doc.restored",
      field: "archived_at",
      oldValue: previous.archived_at,
      newValue: archived,
    });

    await announce(client, previous.workspace_id, previous.container_id, docId, context.actorId);
  });
}

export interface MoveDocInput {
  /** Omitted leaves it where it is; null moves it to the workspace root. */
  containerId?: string | null;
  parentPageId?: string | null;
}

/**
 * Moves a page in the tree.
 *
 * **A page may not become its own ancestor.** The tree is arbitrary depth and
 * the walk that renders it would not return; refusing here is the same guard
 * `moveContainer` has, in the one other place a tree can be reparented.
 */
export async function moveDoc(
  docId: string,
  input: MoveDocInput,
  context: ConfigContext,
): Promise<void> {
  await inTransaction(context, async (client) => {
    const previous = await one(client, docId);

    const containerId = input.containerId === undefined ? previous.container_id : input.containerId;
    const parentPageId =
      input.parentPageId === undefined ? previous.parent_page_id : input.parentPageId;

    if (parentPageId === docId) throw new ConfigError("A page cannot be its own parent");
    if (parentPageId) {
      await requireSameWorkspace(client, parentPageId, previous.workspace_id);
      if (await descendsFrom(client, parentPageId, docId)) {
        throw new ConfigError("A page cannot be moved inside one of its own pages");
      }
    }

    if (containerId === previous.container_id && parentPageId === previous.parent_page_id) return;

    const position = await nextPosition(client, containerId, parentPageId);

    await client.query(
      `UPDATE docs SET container_id = $2, parent_page_id = $3, position = $4, updated_at = now()
       WHERE id = $1`,
      [docId, containerId, parentPageId, position],
    );

    await logConfigChange(client, {
      workspaceId: previous.workspace_id,
      actorId: context.actorId,
      objectKind: "doc",
      objectId: docId,
      verb: "doc.moved",
      field: "container_id",
      oldValue: previous.container_id,
      newValue: containerId,
    });

    // Announced where it came from as well as where it went: a page vanishing
    // from one tree is news to whoever is looking at that tree.
    await announce(client, previous.workspace_id, previous.container_id, docId, context.actorId);
    if (containerId !== previous.container_id) {
      await announce(client, previous.workspace_id, containerId, docId, context.actorId);
    }
  });
}

/**
 * One Yjs update, folded into what is stored.
 *
 * **Not an operation, and no activity row per edit.** An activity row per
 * keystroke batch would bury every other thing that happened to a workspace
 * under one person typing — the log answers "what happened to this", and "a
 * paragraph changed 400 times" is not an answer. `updated_at` carries that a
 * document changed; the document's own history is its CRDT.
 *
 * The merge is the whole write: `applyDocUpdate` refuses anything that is not a
 * readable update, so the stored state cannot be poisoned by one bad request,
 * and the projection is recomputed here because a search that had to load every
 * document is not a search (ADR 6).
 */
export async function applyDocumentUpdate(
  docId: string,
  update: Uint8Array,
  context: ConfigContext,
): Promise<{ searchText: string; updatedAt: Date }> {
  return inTransaction(context, async (client) => {
    // Locked for the merge: two updates landing together would otherwise read
    // the same state, merge their own change into it, and the second write
    // would drop the first. The CRDT makes conflicting *edits* safe, not
    // conflicting read-modify-writes of one row.
    const current = await client.query<{ ydoc: Buffer | null; workspace_id: string }>(
      `SELECT ydoc, workspace_id FROM docs WHERE id = $1 FOR UPDATE`,
      [docId],
    );

    const row = current.rows[0];
    if (!row) throw new ConfigError("That document no longer exists");

    const merged = applyDocUpdate(row.ydoc ? new Uint8Array(row.ydoc) : emptyDocState(), update);

    if (merged.length > MAX_STATE_BYTES) {
      throw new DocumentError(
        `This document has reached its size limit of ${MAX_STATE_BYTES} bytes`,
      );
    }

    const searchText = searchTextFrom(merged);

    const written = await client.query<{ updated_at: Date; container_id: string | null }>(
      `UPDATE docs SET ydoc = $2, search_text = $3, updated_at = now()
       WHERE id = $1 RETURNING updated_at, container_id`,
      [docId, Buffer.from(merged), searchText],
    );

    await announce(client, row.workspace_id, written.rows[0]!.container_id, docId, context.actorId);

    return { searchText, updatedAt: written.rows[0]!.updated_at };
  });
}

/** The block tree a document currently says — what a reader renders. */
export async function loadDocContent(
  docId: string,
  viewerId: string,
  connection: Connection = pool(),
): Promise<ReturnType<typeof richTextFrom>> {
  const doc = await loadDoc(docId, viewerId, connection);
  return doc ? richTextFrom(doc.state) : null;
}

/**
 * Tells everyone who may hear it that a document changed.
 *
 * Inside the transaction like every other announcement (D-090), so a rolled
 * back edit announces nothing. The container is what the route checks a
 * listener's access against; a document on none is workspace-wide and the route
 * falls back to membership (D-112).
 */
async function announce(
  client: PoolClient,
  workspaceId: string,
  containerId: string | null,
  docId: string,
  actorId: string,
): Promise<void> {
  await announceChange(client, {
    w: workspaceId,
    ...(containerId ? { l: containerId } : {}),
    a: actorId,
    d: docId,
  });
}

async function one(client: PoolClient, docId: string): Promise<DocRow> {
  const result = await client.query<DocRow>(
    `SELECT id, workspace_id, container_id, NULL::text AS container_name, parent_page_id,
            title, position, search_text, created_by, created_at, updated_at, archived_at
     FROM docs WHERE id = $1`,
    [docId],
  );

  const row = result.rows[0];
  if (!row) throw new ConfigError("That document no longer exists");
  return row;
}

/**
 * Who a document may name, resolved here rather than by the caller.
 *
 * A mention only becomes a reference if the parser is given the person it could
 * mean (D-083), so a caller that forgets the list does not get an error — it
 * gets a document where "@Riley Kaur" is prose, and nothing on any screen says
 * so. The service has the workspace, so the service asks.
 *
 * **Members of this workspace**, not every user in the database. Somebody who
 * cannot open the document is not somebody it can be about.
 */
async function mentionable(
  client: PoolClient,
  workspaceId: string,
): Promise<{ id: string; name: string }[]> {
  const result = await client.query<{ id: string; name: string }>(
    `SELECT u.id, u.name
     FROM users u JOIN memberships m ON m.user_id = u.id AND m.workspace_id = $1
     WHERE u.deactivated_at IS NULL`,
    [workspaceId],
  );

  return result.rows;
}

async function requireSameWorkspace(
  client: PoolClient,
  docId: string,
  workspaceId: string,
): Promise<void> {
  const result = await client.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM docs WHERE id = $1`,
    [docId],
  );

  if (result.rows[0]?.workspace_id !== workspaceId) {
    throw new ConfigError("That page is not in this workspace");
  }
}

/** Walks up from `startId`, looking for `ancestorId`. Depth-guarded like the tree. */
async function descendsFrom(
  client: PoolClient,
  startId: string,
  ancestorId: string,
): Promise<boolean> {
  let current: string | null = startId;

  for (let depth = 0; current && depth < 64; depth += 1) {
    if (current === ancestorId) return true;
    const result: { rows: { parent_page_id: string | null }[] } = await client.query(
      `SELECT parent_page_id FROM docs WHERE id = $1`,
      [current],
    );
    current = result.rows[0]?.parent_page_id ?? null;
  }

  return false;
}

/** After the last sibling. Fractional, so a reorder writes one row (D-012). */
async function nextPosition(
  client: PoolClient,
  containerId: string | null,
  parentPageId: string | null,
): Promise<string> {
  const result = await client.query<{ position: string }>(
    `SELECT position FROM docs
     WHERE container_id IS NOT DISTINCT FROM $1
       AND parent_page_id IS NOT DISTINCT FROM $2
     ORDER BY position DESC LIMIT 1`,
    [containerId, parentPageId],
  );

  return positionBetween(result.rows[0]?.position ?? null, null);
}
