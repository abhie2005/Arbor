import type { LinkTarget } from "@arbor/core";

/**
 * Where a link node points, as an href.
 *
 * **A plain module, not a `"use server"` file**, because a `"use server"` file
 * may only export async functions and this is a pure one — the lesson
 * `card-options.ts` already learned, which surfaces as an action failing at
 * runtime rather than as a compile error.
 *
 * The target's `kind` is what makes this possible without a query: a page and
 * a task are both uuids, and asking the database which table an id is in would
 * be a round trip to render a sentence (D-120).
 */
export function linkHref(target: LinkTarget): string {
  return target.kind === "page" ? `/docs?doc=${target.id}` : `/t/${target.id}`;
}
