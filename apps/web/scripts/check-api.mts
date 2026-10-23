/**
 * Drives the public API over HTTP, the way a token holder does (D-133).
 *
 * **Why this is its own script.** `check:actions` is built on `actionIds()`,
 * which reads a manifest only a dev build emits — the public API has no server
 * actions and no manifest, so like `check:search` (D-115) this is a plain
 * HTTP suite that runs against anything serving the app: a dev server, the
 * container image, a deployed URL.
 *
 *   npm run check:api            # localhost:3000
 *   npm run check:api -- 3300    # or a port
 *   BASE_URL=https://arbor.example npm run check:api
 *
 * **What it is for is the half no other gate can see.** `db:smoke` proves
 * `principalForToken` rejects a revoked row and that the compiler scopes by
 * principal. Neither can prove the *route* asks either question — that it
 * refuses an absent token before touching the database, that it answers a
 * cross-workspace scope with an empty page rather than a refusal (invariant 6),
 * or that a malformed body is a 400 and not a stack trace.
 *
 * It mints its own tokens rather than using the seeded one, whose plaintext
 * exists only in the seed's output, and deletes the accounts it created.
 */
import { DEFAULT_VIEW_DEFINITION } from "@arbor/core";
import { createApiToken, revokeApiToken } from "@arbor/db";
import { Client } from "pg";

const PORT = process.argv[2] ?? process.env.PORT ?? "3000";
const BASE = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://arbor:arbor@localhost:5432/arbor";

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
const one = async (sql: string, params: unknown[] = []) =>
  (await db.query(sql, params)).rows[0] as Record<string, string> | undefined;

const workspace = await one(`SELECT id FROM workspaces WHERE slug = 'northwind'`);
const other = await one(`SELECT id FROM workspaces WHERE slug = 'meridian'`);
const owner = await one(`SELECT id FROM users WHERE email = 'avery@example.com'`);
const engineering = await one(`SELECT id FROM containers WHERE name = 'Engineering'`);
const founders = await one(`SELECT id FROM containers WHERE name = 'Founders'`);
const theirList = await one(`SELECT id FROM containers WHERE name = 'Dispatch board'`);

if (!workspace || !owner || !engineering || !founders || !other || !theirList) {
  console.error("The seeded demo workspace is missing. Run `npm run db:seed` first.");
  process.exit(1);
}

console.log(`\npublic API → ${BASE}/api/v1\n`);

async function query(
  token: string | null,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${BASE}/api/v1/views/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });

  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, json };
}

const everything = { scope: { kind: "everything" }, definition: DEFAULT_VIEW_DEFINITION };
const keysOf = (json: Record<string, unknown>) =>
  ((json.tasks as { key: string | null }[] | undefined) ?? []).map((task) => task.key);

// --- a token nobody issued --------------------------------------------------
const anonymous = await query(null, everything);
report(
  "no token is a 401, before anything is read",
  anonymous.status === 401 ? null : `status ${anonymous.status}`,
);

const nonsense = await query("arb_not-a-real-token", everything);
report(
  "and so is a token that was never issued",
  nonsense.status === 401 ? null : `status ${nonsense.status}`,
);

const wrongScheme = await fetch(`${BASE}/api/v1/views/query`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Basic abc" },
  body: JSON.stringify(everything),
});
report(
  "a cookie or a Basic header is not a credential here",
  wrongScheme.status === 401 ? null : `status ${wrongScheme.status}`,
);

// --- a token scoped to one space -------------------------------------------
const context = { actorId: owner.id!, connection: undefined };
const scoped = await createApiToken(
  { workspaceId: workspace.id!, name: "check:api engineering", containerId: engineering.id!, permission: "view" },
  context,
);

const open = await query(scoped.token, everything);
report(
  "a token reads the workspace it was minted in",
  open.status === 200 && keysOf(open.json).some((key) => key?.startsWith("ENG-"))
    ? null
    : `status ${open.status}, ${keysOf(open.json).length} rows`,
);

report(
  "and reads nothing it was not granted — the private space stays private",
  keysOf(open.json).includes("HIRE-1")
    ? "permission leak: a task from the private space came back"
    : null,
);

// --- the same shape, granted on the private space instead ------------------
const privileged = await createApiToken(
  { workspaceId: workspace.id!, name: "check:api founders", containerId: founders.id!, permission: "view" },
  context,
);
const inside = await query(privileged.token, everything);
report(
  "a token granted the private space reads it, so the last check was the grant",
  keysOf(inside.json).includes("HIRE-1")
    ? null
    : `the grantee sees ${keysOf(inside.json).length} rows and not HIRE-1`,
);

report(
  "and that one does not read the space it was not granted",
  keysOf(inside.json).some((key) => key?.startsWith("ENG-"))
    ? "permission leak: the Engineering tree came back"
    : null,
);

// --- another workspace's container, named by id ----------------------------
const across = await query(scoped.token, {
  scope: { kind: "list", id: theirList.id },
  definition: DEFAULT_VIEW_DEFINITION,
});
report(
  "a scope in another workspace is an empty page, not a refusal (invariant 6)",
  across.status === 200 && keysOf(across.json).length === 0
    ? null
    : `status ${across.status}, ${keysOf(across.json).length} rows`,
);

// --- bodies that are not a query -------------------------------------------
const noScope = await query(scoped.token, { definition: DEFAULT_VIEW_DEFINITION });
report("a body with no scope is a 400", noScope.status === 400 ? null : `status ${noScope.status}`);

const nonsenseFilter = await query(scoped.token, {
  scope: { kind: "everything" },
  definition: { ...DEFAULT_VIEW_DEFINITION, filters: { op: "nope", clauses: "not a list" } },
});
report(
  "a definition the compiler cannot express is a 400, not a 500",
  nonsenseFilter.status === 400 ? null : `status ${nonsenseFilter.status}`,
);

report(
  "and the refusal says nothing about the inside of the system",
  JSON.stringify(nonsenseFilter.json).match(
    /\bselect\b|\bpostgres\b|\bsyntax\b|\.ts:\d|\bat \w+ \(/i,
  )
    ? `the error body leaks internals: ${JSON.stringify(nonsenseFilter.json).slice(0, 160)}`
    : null,
);

// --- the page size ---------------------------------------------------------
const limited = await query(scoped.token, { ...everything, limit: 2 });
report(
  "a limit is honoured",
  limited.status === 200 && keysOf(limited.json).length <= 2
    ? null
    : `status ${limited.status}, ${keysOf(limited.json).length} rows`,
);

const absurd = await query(scoped.token, { ...everything, limit: 100000 });
report(
  "and is clamped rather than refused",
  absurd.status === 200 && (absurd.json.limit as number) <= 200
    ? null
    : `status ${absurd.status}, limit ${String(absurd.json.limit)}`,
);

// --- what a call leaves behind --------------------------------------------
const used = await one(`SELECT last_used_at FROM api_tokens WHERE id = $1`, [scoped.record.id]);
report(
  "a call stamps last_used_at, which is what makes a token revocable with confidence",
  used?.last_used_at ? null : "the token has never been used according to its row",
);

const principal = await one(`SELECT name, kind FROM users WHERE id = $1`, [
  scoped.record.principalId,
]);
report(
  "a token speaks as a named service account, so its writes are attributable",
  principal?.kind === "service" && principal?.name === "check:api engineering"
    ? null
    : `the principal is ${JSON.stringify(principal)}`,
);

// --- revoking --------------------------------------------------------------
await revokeApiToken(scoped.record.id, workspace.id!, context);
const afterRevoke = await query(scoped.token, everything);
report(
  "a revoked token is a 401",
  afterRevoke.status === 401 ? null : `status ${afterRevoke.status}`,
);

// --- expiry ----------------------------------------------------------------
const expiring = await createApiToken(
  {
    workspaceId: workspace.id!,
    name: "check:api expired",
    containerId: engineering.id!,
    permission: "view",
    expiresInDays: 1,
  },
  context,
);
await db.query(`UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
  expiring.record.id,
]);
const afterExpiry = await query(expiring.token, everything);
report(
  "and so is an expired one",
  afterExpiry.status === 401 ? null : `status ${afterExpiry.status}`,
);

// Clean up: deleting the service accounts takes their tokens, memberships and
// grants with them, which is why revoking does not delete one (D-133).
await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
  [scoped.record.principalId, privileged.record.principalId, expiring.record.principalId],
]);

console.log(failures === 0 ? "\nall api checks passed\n" : `\n${failures} check(s) failed\n`);
await db.end();
process.exit(failures === 0 ? 0 : 1);
