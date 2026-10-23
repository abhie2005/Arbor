import "server-only";

import { type TokenPrincipal, principalForToken } from "@arbor/db";

/**
 * Who a public API request speaks as (D-133).
 *
 * **A bearer token, and nothing else.** No cookie fallback: a session belongs
 * to a browser and carries CSRF considerations the API has no answer for, and
 * an endpoint that accepts either is an endpoint where a logged-in person's
 * browser can be made to call the API by a page they visited. The two doors
 * stay separate.
 *
 * The principal returned is a service account, so every read and write
 * downstream is scoped by the same `access_index` join the app uses — which is
 * what makes this helper short (D-126).
 */
export async function principalFromRequest(request: Request): Promise<TokenPrincipal | null> {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return null;

  const token = rest.join(" ").trim();
  return token ? principalForToken(token) : null;
}

/**
 * The one refusal shape this API has.
 *
 * It says *whether* the credential worked and never what the system contains
 * (invariant 6) — a 401 for a missing, malformed, revoked or expired token
 * alike, because telling those apart tells a caller which tokens exist.
 */
export function apiError(status: number, message: string): Response {
  return Response.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}
