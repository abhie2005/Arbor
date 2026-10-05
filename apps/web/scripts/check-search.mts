/**
 * Drives `/search` over HTTP, the way a person with a URL does.
 *
 * **Why this is not part of `check:actions`.** That script exists for the seam
 * where a React handler calls a *server action*, and everything in it is built
 * on `actionIds()` — which reads the `exportedName` manifest that only a **dev**
 * build emits. A production build's `server-reference-manifest.json` maps action
 * ids to routes and carries no export names, because they are minified away.
 *
 * Search has no server action. The query lives in the URL and the screen is a
 * GET (D-113), so none of that machinery applies, and requiring it would mean
 * this screen could only ever be checked against `next dev`. As a plain GET
 * suite it runs against **anything that serves the app** — a dev server, the
 * container image, a deployed environment:
 *
 *   npm run check:search            # localhost:3000
 *   npm run check:search -- 3200    # or a port
 *   BASE_URL=https://arbor.example npm run check:search
 *
 * It needs the seeded demo workspace, because the permission checks are the
 * point and they need Riley's private space to exist.
 *
 * **What it is really for** is the half of search that no other gate can see.
 * `db:smoke` proves `searchDocs` filters rows; unit tests prove the snippet and
 * the marks. Neither can prove the screen *renders* what the loader found, and
 * neither would have caught the bug that shipped this feature's first draft: a
 * status query selecting a `workspace_id` that does not exist on `statuses`,
 * which typechecks fine because it lives in a SQL string.
 */
import { signIn } from "@arbor/db";
import { Client } from "pg";

const PORT = process.argv[2] ?? process.env.PORT ?? "3000";
const BASE = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://arbor:arbor@localhost:5432/arbor";

/** A word that exists nowhere in the seed, so a leak cannot be a coincidence. */
const SECRET = "quokkaconfidential";

let failures = 0;

function report(label: string, problem: string | null) {
  if (problem) {
    failures += 1;
    console.log(`  FAIL  ${label}\n        ${problem}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

const db = new Client({ connectionString: DATABASE_URL });
await db.connect();
const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

async function get(path: string, cookie: string): Promise<string> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Cookie: cookie },
    // Manual, so a redirect to /login is a visible failure rather than a page
    // of login HTML that none of the assertions below happen to match.
    redirect: "manual",
  });
  if (response.status !== 200) {
    throw new Error(`GET ${path} returned ${response.status} — is a server up on ${BASE}?`);
  }
  return response.text();
}

/**
 * The page as a person reads it, with the markup taken out.
 *
 * **Content assertions have to go through this, not the raw HTML**, because the
 * thing being searched for is exactly the thing the renderer takes apart: a
 * title that matches the query is split into `<mark>` and `<span>` runs, so
 * searching "rollout" makes "Rollout handbook" render as
 * `<mark>Rollout</mark><span> handbook</span>` and a grep for the title finds
 * nothing. That cost an hour: the check failed, accused the permission scoping,
 * and the page had been correct the whole time. A query that does *not* match
 * the title leaves it in one piece, which is why a neighbouring check passed
 * and made it look like a permissions bug rather than a regex one.
 *
 * Markup assertions (`<mark`, `search-status`) deliberately still use the raw
 * HTML — that is the point of them.
 */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

console.log(`\nsearch → GETs against ${BASE}\n`);

const { token: averyToken } = await signIn("avery@example.com", "arbor-demo-2026");
const { token: samToken } = await signIn("sam@example.com", "arbor-demo-2026");
const AVERY = `arbor_session=${averyToken}`;
const SAM = `arbor_session=${samToken}`;

const workspaceId = (await one(`SELECT id FROM workspaces LIMIT 1`)).id;
const hiring = await one(`SELECT id FROM containers WHERE name = 'Hiring'`);
report(
  "the seed's private space exists, so the permission checks mean something",
  hiring?.id ? null : "no 'Hiring' container — run npm run db:seed",
);

// Sam must not hold a grant on it. Deleting the grant alone would leave
// `access_index` holding what it implied, which is how a permission check first
// passed here for the wrong reason.
const samId = (await one(`SELECT id FROM users WHERE email = 'sam@example.com'`)).id;
await db.query(`DELETE FROM grants WHERE container_id = $1 AND principal_id = $2`, [hiring.id, samId]);
await db.query(`DELETE FROM access_index WHERE container_id = $1 AND principal_id = $2`, [hiring.id, samId]);

// Written straight to the table: this suite is about *reading* `search_text`,
// and `createDoc` plus a Yjs push is `check:actions`' subject. `ydoc` is
// nullable and always has been, so a row without one is a legal document.
await db.query(`DELETE FROM docs WHERE workspace_id = $1 AND title IN ('Rollout handbook', 'Offer letters')`, [
  workspaceId,
]);
await db.query(
  `INSERT INTO docs (workspace_id, container_id, title, search_text, position)
   VALUES ($1, NULL, 'Rollout handbook', 'The ritual before shipping on a Friday is the smoke check.', 'zz1'),
          ($1, $2,   'Offer letters',    'Compensation bands and the phrase ${SECRET} nobody outside may read.', 'zz2')`,
  [workspaceId, hiring.id],
);

try {
  const byText = await get("/search?q=ritual+before+shipping", AVERY);
  report(
    "a page is found by a phrase in its text, through the screen",
    /Rollout handbook/.test(visibleText(byText)) ? null : "the page containing the phrase was not rendered",
  );

  report(
    "and the matched words are marked in the snippet",
    /<mark[^>]*>/.test(byText) ? null : "nothing on the page was marked as the match",
  );

  // Asserted on the key, not on the word searched for: "drag" appears in markup
  // for unrelated reasons, and a check that passes because the page mentions
  // `draggable` is not checking search.
  const byName = await get("/search?q=drag+performance", AVERY);
  report(
    "a task is found by its name, through the compiler's own filters.search",
    /ENG-415/.test(visibleText(byName)) ? null : "searching a phrase from ENG-415's name did not render it",
  );

  report(
    "a task result carries its status and where it lives",
    /search-status/.test(byName) && /search-path/.test(byName)
      ? null
      : "the task row rendered without a status pill or a container path",
  );

  // The check the feature rests on.
  const samSees = await get(`/search?q=${SECRET}`, SAM);
  report(
    "a private page's prose does not reach a member with no grant on it",
    !new RegExp(`${SECRET}|Offer letters|Compensation bands`).test(visibleText(stripQueryEcho(samSees)))
      ? null
      : "search put a private page's contents on the page of somebody who cannot read it",
  );

  report(
    "and the empty result does not admit the page exists (invariant 6)",
    /Nothing matches/.test(visibleText(samSees)) ? null : "the refusal said something other than 'nothing matches'",
  );

  const averySees = await get(`/search?q=${SECRET}`, AVERY);
  report(
    "while somebody who may read it finds it, so the empty result was the permission",
    /Offer letters/.test(visibleText(averySees)) ? null : "the owner could not find a page in their own workspace",
  );

  // The sharpest version: one query, two viewers, and the only difference is a
  // grant. Asserted as two checks rather than one `&&`, because a single
  // failure message covering both halves cannot say which half broke — and when
  // it first fired it was the *public* page missing, while the message accused
  // the private one of leaking.
  const samRollout = await get("/search?q=rollout", SAM);
  report(
    "a member sees the workspace-wide page for a query both pages could match",
    /Rollout handbook/.test(visibleText(samRollout))
      ? null
      : "the public page did not render, so the next check proves nothing",
  );
  report(
    "and does not see the private one for that same query",
    !/Offer letters/.test(visibleText(stripQueryEcho(samRollout)))
      ? null
      : "the same query returned the private page to somebody with no grant",
  );

  // `ILIKE '%%'` is true of every non-null value, so a blank query is the most
  // expensive search in the app rather than the cheapest. `parseQuery` returns
  // null and the screen renders a prompt.
  const blank = await get("/search?q=+++", AVERY);
  report(
    "a blank query renders a prompt rather than the whole workspace",
    /Search this workspace/.test(visibleText(blank)) && !/Rollout handbook/.test(visibleText(blank))
      ? null
      : "a blank query returned results",
  );
} finally {
  await db.query(`DELETE FROM docs WHERE workspace_id = $1 AND title IN ('Rollout handbook', 'Offer letters')`, [
    workspaceId,
  ]);
  await db.end();
}

/**
 * What is left after removing every place the viewer's *own query* is echoed.
 *
 * Three places, and the third is the one that made this check cry leak on a
 * page that had not leaked: "Nothing matches <term>", the search box's value,
 * and **Next's RSC flight payload** — the `self.__next_f.push(...)` script
 * blocks, which carry the serialized props and therefore the search term, in
 * clear, on every render. A grep for the secret word finds the viewer's typing
 * there and reports it as the document's prose.
 *
 * Scripts are dropped wholesale rather than parsed: nothing this suite asserts
 * lives in one, so there is no reason to be clever about it.
 */
function stripQueryEcho(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<p>[\s\S]*?Nothing matches[\s\S]*?<\/p>/g, "")
    .replace(/<input[^>]*>/g, "");
}

console.log(failures === 0 ? "\nall search checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
