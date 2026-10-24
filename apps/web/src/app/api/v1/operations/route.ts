import { type Operation, MutationError, invertBatch, parseOperations } from "@arbor/core";
import {
  AccessDenied,
  MutationRejected,
  applyOperations,
  requireListAccess,
  requireTasksAccess,
} from "@arbor/db";

import { apiError, principalFromRequest } from "@/server/api-auth";

/**
 * `POST /api/v1/operations` — the write half of the public API (D-134).
 *
 * **It takes `Operation[]`, which is the only thing that writes task data**
 * (invariant 1). An endpoint with its own verbs would be the second writer, and
 * the second writer is the one that forgets to log — so a caller posts what the
 * browser's own undo stack holds, and gets the activity row, the live nudge and
 * the invertibility by construction rather than by remembering.
 *
 * **`parseOperations` first, and it had to be written for this.** `Operation`
 * is a TypeScript union and types are erased: until D-134 nothing checked one
 * at runtime, and `undo` has handed client-supplied operations to the executor
 * since Phase 2 on the strength of an annotation. Same-origin, from our own
 * bundle — defensible. Reachable with a bearer token — not.
 *
 * **Authorization is per operation, and `createTask` is the one that cannot go
 * through the others' check.** Every other kind names a task, so
 * `requireTasksAccess` asks the same question `undo` asks (D-080). A creation
 * names a *container* and the task does not exist yet, so it takes `edit` on
 * the list instead — which is the check that stops a row being put inside a
 * list the caller cannot read.
 *
 * **The inverses come back.** The undo stack lives with whoever called
 * (D-124), so the response carries what to POST to undo this batch. An
 * automation has no stack because it never asked for one; an API caller can
 * keep theirs.
 *
 * **One status for both halves of a refused task.** Invariant 6 forbids
 * distinguishing "unreachable" from "missing", and an HTTP status is exactly
 * the kind of thing that would — so both are 403 and the *message* is what
 * separates "no longer exists" from "you do not have permission".
 */

export const dynamic = "force-dynamic";

interface OperationsBody {
  operations?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const principal = await principalFromRequest(request);
  if (!principal) return apiError(401, "A valid bearer token is required");

  let body: OperationsBody;
  try {
    body = (await request.json()) as OperationsBody;
  } catch {
    return apiError(400, "The body must be JSON");
  }

  let operations: Operation[];
  try {
    operations = parseOperations(body?.operations);
  } catch (error) {
    // The parser's message names the index and key of the caller's own payload,
    // which describes their request rather than anything inside this system.
    return apiError(400, error instanceof MutationError ? error.message : "Invalid operations");
  }

  if (operations.length === 0) {
    return Response.json(
      { applied: 0, skipped: 0, notified: 0, inverse: [] },
      { headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const creates = operations.filter((op) => op.kind === "createTask");
    const existing = operations.filter((op) => op.kind !== "createTask");

    for (const op of creates) {
      if (op.kind === "createTask") {
        await requireListAccess(op.listId, principal.principalId, "edit");
      }
    }

    await requireTasksAccess(
      existing.map((op) => op.taskId),
      principal.principalId,
      "edit",
    );
  } catch (error) {
    if (error instanceof AccessDenied) return apiError(403, error.message);
    throw error;
  }

  try {
    const result = await applyOperations(operations, { actorId: principal.principalId });

    return Response.json(
      { ...result, inverse: invertBatch(operations) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    // A batch the executor refuses — a task that vanished between the check and
    // the write, a time entry that ends before it starts — is a bad request
    // rather than a broken server, and these messages are written to be read.
    if (error instanceof MutationRejected || error instanceof MutationError) {
      return apiError(400, error.message);
    }
    console.error("[api] operations failed", error);
    return apiError(500, "That batch could not be applied");
  }
}
