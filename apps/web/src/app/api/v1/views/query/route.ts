import {
  type ViewDefinition,
  type ViewScope,
  compileViewQuery,
} from "@arbor/core";
import { executeCompiled, loadFieldCatalog } from "@arbor/db";

import { apiError, principalFromRequest } from "@/server/api-auth";

/**
 * `POST /api/v1/views/query` — the read half of the public API (D-133).
 *
 * **It takes a view definition, because that is the query language this app
 * already has.** Invariant 2 says no renderer has a query of its own; an API
 * with its own filter syntax would be exactly the second opinion that rule
 * exists to prevent — and it would arrive without custom fields, without nested
 * AND/OR, and without the permission scoping all of that is built on. A caller
 * posts what a saved view stores, and the compiler answers.
 *
 * **Permission scoping is free and is not optional.** `viewerId` is the
 * token's service account, so the access-index join is the same one every
 * screen uses: a scope naming a container the token was never granted returns
 * no rows rather than a refusal, which is what invariant 6 requires — a
 * refusal that differed from "empty" would say which containers exist.
 *
 * **Validation is compilation.** There is no second schema to keep in step: a
 * definition the compiler cannot express throws, and anything a malformed body
 * does downstream is caught and answered 400 with no detail. The detail goes to
 * the logs, because this endpoint talks to whoever holds a token.
 *
 * Rows are the compiler's own columns, unchanged. Naming them again at this
 * boundary would be the second vocabulary the design avoids; whether a public
 * API should promise snake_case for ever is an open question in
 * `docs/STATUS.md`.
 */

export const dynamic = "force-dynamic";

/** A page nobody asked a size for, and the largest one anybody may ask for. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface QueryBody {
  scope?: ViewScope;
  definition?: ViewDefinition;
  limit?: number;
  after?: { sortValues: unknown[]; id: string };
}

export async function POST(request: Request): Promise<Response> {
  const principal = await principalFromRequest(request);
  if (!principal) return apiError(401, "A valid bearer token is required");

  let body: QueryBody;
  try {
    body = (await request.json()) as QueryBody;
  } catch {
    return apiError(400, "The body must be JSON");
  }

  if (!body?.scope || !body?.definition) {
    return apiError(400, "A scope and a definition are required");
  }

  const limit = Math.min(
    Math.max(Math.trunc(Number(body.limit ?? DEFAULT_LIMIT)) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );

  try {
    const query = compileViewQuery({
      workspaceId: principal.workspaceId,
      viewerId: principal.principalId,
      fields: await loadFieldCatalog(principal.workspaceId),
      scope: body.scope,
      definition: body.definition,
      limit,
      after: body.after,
    });

    const tasks = await executeCompiled(query);

    return Response.json(
      { tasks, limit },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    // One message for every shape of bad request, logged in full on this side.
    console.error("[api] view query refused", error);
    return apiError(400, "That query could not be compiled");
  }
}
