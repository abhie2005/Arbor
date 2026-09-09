/**
 * Drives the settings server actions the way a button click does.
 *
 * **Why this exists.** Every layer beneath the screen is already covered:
 * @arbor/core has unit tests, and `db:smoke` runs the services against real
 * Postgres. Neither touches the seam where a React handler calls a server
 * action — which is exactly where the undo bug lived through two wrong fixes
 * (D-040), because every diagnosis was reasoned from the code and none was
 * observed running.
 *
 * A server action is an HTTP POST to the page URL carrying a `Next-Action`
 * header and the argument array as the body. That is what this sends. It
 * verifies the arguments serialize, the action runs as a real user, the
 * service commits, and — the part unit tests cannot see — that a rejected edit
 * comes back as a message the form can render rather than a 500.
 *
 * It does not exercise the browser: nothing here proves a click is wired to
 * the handler. That still needs a real browser.
 *
 *   npm run dev                 # port 3000, from the repo root
 *   npm run check:actions
 *
 * Pass a port if the dev server is somewhere else:
 *
 *   npm run check:actions -- 3100
 */
import { signIn } from "@arbor/db";
import { UndoStack } from "@arbor/core";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";

// Defaults to the port `npm run dev` uses, so the two commands compose without
// anyone having to know a second number.
const PORT = process.argv[2] ?? process.env.PORT ?? "3000";
const PAGE = `http://localhost:${PORT}/settings/statuses`;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://arbor:arbor@localhost:5432/arbor";

/**
 * Action ids are content hashes Next assigns at build time, so they cannot be
 * hard-coded. The compiled server bundle carries the id-to-export mapping in a
 * url-encoded manifest string; this reads it out of the dev build.
 */
/**
 * Next compiles routes on demand, so a freshly started dev server has no
 * bundle to read ids out of until something asks for the page. Ask for it.
 */
async function warm(path: string): Promise<void> {
  const response = await fetch(`http://localhost:${PORT}${path}`, {
    headers: COOKIE ? { Cookie: COOKIE } : {},
  });
  if (!response.ok) {
    throw new Error(`GET ${path} returned ${response.status} — is the dev server on ${PORT}?`);
  }
  await response.text();
}

function actionIds(route = "app/settings/statuses/page"): Record<string, string> {
  const bundle = `.next/server/${route}.js`;
  let source;
  try {
    source = readFileSync(bundle, "utf8");
  } catch {
    throw new Error(
      `${bundle} not found even after loading the page — has the route moved?`,
    );
  }

  const ids: Record<string, string> = {};
  const pattern = /%22id%22%3A%22([0-9a-f]{40,44})%22%2C%22exportedName%22%3A%22(\w+)%22/g;
  for (const match of source.matchAll(pattern)) ids[match[2]] = match[1];

  if (Object.keys(ids).length === 0) {
    throw new Error("No server action ids found — has the settings page compiled?");
  }
  return ids;
}

/**
 * A real session, minted the way signing in does.
 *
 * Every page redirects to /login without one now, so these checks have to be
 * authenticated — which is an improvement: they exercise the same session
 * lookup a browser does, rather than a development bypass that will not exist
 * in production.
 */
const { token: sessionToken } = await signIn("avery@example.com", "arbor-demo-2026");
const COOKIE = `arbor_session=${sessionToken}`;

await warm("/settings/statuses");
await warm("/");

const IDS = actionIds();
let failures = 0;

function report(label: string, problem: string | null) {
  if (problem) {
    failures++;
    console.log(`  FAIL  ${label}\n        ${problem}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

async function callOn(url: string, id: string, args: unknown, cookie: string = COOKIE) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Next-Action": id,
      "Content-Type": "text/plain;charset=UTF-8",
      Cookie: cookie,
    },
    body: JSON.stringify(args),
  });

  return { status: response.status, text: await response.text() };
}

async function call(name: string, args: unknown) {
  const id = IDS[name];
  if (!id) throw new Error(`No action id for ${name}`);
  return callOn(PAGE, id, args);
}

/** The action's return value arrives inside the RSC flight stream. */
function returned(text: string): { ok: boolean; error?: string } | null {
  if (/"ok":true/.test(text)) return { ok: true };
  const error = text.match(/"error":"((?:[^"\\]|\\.)*)"/);
  if (error) return { ok: false, error: JSON.parse(`"${error[1]}"`) as string };
  return null;
}

const db = new Client({ connectionString: DATABASE_URL });
await db.connect();
const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

console.log("\nsettings actions → server → postgres\n");

const setName = `Action Check ${Date.now()}`;
let result = await call("createStatusSetAction", [setName, "simple", null]);
report(
  "creating a set from a template returns ok",
  result.status === 200 && returned(result.text)?.ok ? null : `status ${result.status}`,
);

const set = await one(`SELECT id FROM status_sets WHERE name = $1`, [setName]);
report("the set reached postgres", set ? null : "no row was written");

const statuses = (
  await db.query(
    `SELECT id, name, position FROM statuses WHERE status_set_id = $1 ORDER BY position`,
    [set.id],
  )
).rows;
report(
  "the template's statuses landed in order",
  statuses.length === 3 && statuses[0].name === "To Do" ? null : JSON.stringify(statuses),
);

result = await call("updateStatusAction", [statuses[0].id, { name: "Queued" }]);
const renamed = await one(`SELECT name FROM statuses WHERE id = $1`, [statuses[0].id]);
report(
  "renaming a status commits",
  returned(result.text)?.ok && renamed.name === "Queued" ? null : `name is ${renamed.name}`,
);

// The one a unit test cannot check: a rejected edit has to arrive as a message
// beside the control, not as an exception that replaces the screen.
result = await call("updateStatusAction", [statuses[2].id, { group: "active" }]);
const rejection = returned(result.text);
report(
  "an invalid edit returns an error to the form rather than throwing",
  result.status === 200 && rejection && !rejection.ok && /done or closed/.test(rejection.error)
    ? null
    : `status ${result.status} → ${JSON.stringify(rejection)}`,
);

result = await call("moveStatusAction", [statuses[2].id, 0]);
const reordered = (
  await db.query(`SELECT name FROM statuses WHERE status_set_id = $1 ORDER BY position`, [set.id])
).rows.map((row) => row.name);
report(
  "reordering renumbers the whole set",
  returned(result.text)?.ok && reordered[0] === "Done" ? null : reordered.join(", "),
);

await call("addStatusAction", [set.id, "Blocked", "active", "#ec5b5b"]);
const added = await one(
  `SELECT id FROM statuses WHERE status_set_id = $1 AND name = 'Blocked'`,
  [set.id],
);
report("adding a status works", added ? null : "no status was added");

result = await call("deleteStatusAction", [added.id, statuses[0].id]);
const gone = await one(`SELECT id FROM statuses WHERE id = $1`, [added.id]);
report(
  "deleting a status with a replacement works",
  returned(result.text)?.ok && !gone ? null : "the status is still there",
);

const fieldName = `Action Field ${Date.now()}`;
result = await call("createFieldAction", [
  {
    name: fieldName,
    type: "drop_down",
    containerId: null,
    typeConfig: {
      options: [{ id: crypto.randomUUID(), name: "Yes", color: "#43b581", orderindex: 0 }],
    },
  },
]);
const field = await one(`SELECT id, type, type_config FROM fields WHERE name = $1`, [fieldName]);
report(
  "a field's per-type config survives the action boundary",
  returned(result.text)?.ok && field?.type === "drop_down" && field.type_config.options.length === 1
    ? null
    : JSON.stringify(field),
);

result = await call("createFieldAction", [
  { name: `Bad ${Date.now()}`, type: "drop_down", containerId: null, typeConfig: { options: [] } },
]);
const badConfig = returned(result.text);
report(
  "an invalid field config is refused with an explanation",
  result.status === 200 && badConfig && !badConfig.ok && /at least one option/.test(badConfig.error)
    ? null
    : `${result.status} → ${JSON.stringify(badConfig)}`,
);

// --- undo, through the real stack ------------------------------------------
//
// The regression that was missing. Every layer passed on its own: `invert` has
// unit tests, `db:smoke` proves the write path, and the stack had seven tests —
// all of them exercising it in isolation with a forward operation. Nothing
// tested the *composition* of "the server returns the inverse" (D-036) with "the
// stack inverts on pop", which is where the double inversion lived (D-049).
//
// So this runs the composition: the real action, the real stack, the real
// database.
console.log("\nundo → the real stack → postgres\n");

const PAGE_ACTIONS = actionIds("app/page");
const task = await one(`SELECT id, status_id FROM tasks WHERE key = 'ENG-415'`);

const cycled = await callOn(
  "http://localhost:" + PORT + "/",
  PAGE_ACTIONS.cycleStatus!,
  [task.id],
);
const inverse = cycled.text.match(/\[\{"kind":"setField".*?\}\]/);
const moved = await one(`SELECT status_id FROM tasks WHERE id = $1`, [task.id]);

report(
  "clicking a status dot moves the task and returns an inverse",
  inverse && moved.status_id !== task.status_id ? null : "no inverse came back",
);

const stack = new UndoStack(20);
stack.push(JSON.parse(inverse![0]));
const toApply = stack.pop();

report(
  "the stack hands back the server's inverse unchanged",
  toApply?.[0] && (toApply[0] as { to: string }).to === task.status_id
    ? null
    : `stack produced ${JSON.stringify(toApply)}`,
);

await callOn("http://localhost:" + PORT + "/", PAGE_ACTIONS.undo!, [toApply]);
const restored = await one(`SELECT status_id FROM tasks WHERE id = $1`, [task.id]);

report(
  "undo puts the task back where it started",
  restored.status_id === task.status_id
    ? null
    : "the row did not move back — the double inversion is back",
);

// --- board drag ------------------------------------------------------------
//
// A drag changes two fields, and undoing it has to reverse both together —
// putting the card back in the right column but the wrong place is not an undo.
console.log("\nboard drag → two fields, one undo entry\n");

await warm("/board");

const column = (
  await db.query<{ id: string; position: string; status_id: string }>(
    `SELECT t.id, t.position, t.status_id
     FROM tasks t JOIN statuses s ON s.id = t.status_id
     WHERE s.name = 'In Progress' AND t.deleted_at IS NULL
     ORDER BY t.position LIMIT 3`,
  )
).rows;

const todo = await one(`SELECT id FROM statuses WHERE name = 'Todo' LIMIT 1`);
const dragged = column[0]!;
const neighbours = (
  await db.query<{ id: string; position: string }>(
    `SELECT t.id, t.position FROM tasks t JOIN statuses s ON s.id = t.status_id
     WHERE s.id = $1 AND t.deleted_at IS NULL ORDER BY t.position`,
    [todo.id],
  )
).rows;

const dropped = await callOn(
  "http://localhost:" + PORT + "/",
  PAGE_ACTIONS.moveTask!,
  [dragged.id, todo.id, neighbours[0]?.id ?? null, null],
);

const landed = await one(`SELECT status_id, position FROM tasks WHERE id = $1`, [dragged.id]);
report(
  "a drag moves the card to the target column",
  landed.status_id === todo.id ? null : `status is ${landed.status_id}`,
);
report(
  "and lands after the card it was dropped below",
  neighbours[0] ? (landed.position > neighbours[0].position ? null : `position ${landed.position} is not after ${neighbours[0].position}`) : null,
);

const dragInverse = dropped.text.match(/\[\{"kind":"setField".*?\}\]/);
const undoStack = new UndoStack(20);
undoStack.push(JSON.parse(dragInverse![0]));
const back = undoStack.pop();

report(
  "one drag is one undo entry, carrying both changed fields",
  back?.length === 2 ? null : `the inverse has ${back?.length ?? 0} operations`,
);

await callOn("http://localhost:" + PORT + "/", PAGE_ACTIONS.undo!, [back]);
const reverted = await one(`SELECT status_id, position FROM tasks WHERE id = $1`, [dragged.id]);
report(
  "undoing a drag restores both the column and the place in it",
  reverted.status_id === dragged.status_id && reverted.position === dragged.position
    ? null
    : `status ${reverted.status_id} position ${reverted.position}`,
);

console.log("\nsigning in → a session, or nothing\n");

await warm("/login");
const LOGIN_ACTIONS = actionIds("app/login/page");
const LOGIN_URL = "http://localhost:" + PORT + "/login";

// Posted without a cookie: this is the one request in the file that must work
// for someone who is not signed in.
const badLogin = await fetch(LOGIN_URL, {
  method: "POST",
  headers: { "Next-Action": LOGIN_ACTIONS.signInAction!, "Content-Type": "text/plain;charset=UTF-8" },
  body: JSON.stringify(["avery@example.com", "not the password"]),
});
const badBody = await badLogin.text();
report(
  "the wrong password is refused",
  /"ok":false/.test(badBody) ? null : "a wrong password was accepted",
);
report(
  "and no session cookie comes back with the refusal",
  !String(badLogin.headers.get("set-cookie") ?? "").includes("arbor_session=")
    ? null
    : "a session cookie was issued for a failed sign-in",
);

const goodLogin = await fetch(LOGIN_URL, {
  method: "POST",
  headers: { "Next-Action": LOGIN_ACTIONS.signInAction!, "Content-Type": "text/plain;charset=UTF-8" },
  body: JSON.stringify(["avery@example.com", "arbor-demo-2026"]),
});
const issued = String(goodLogin.headers.get("set-cookie") ?? "");
report(
  "the right password issues a session cookie",
  issued.includes("arbor_session=") ? null : `set-cookie was "${issued.slice(0, 60)}"`,
);
report(
  "and the cookie is httpOnly, so script on the page cannot read the token",
  /httponly/i.test(issued) ? null : "the session cookie is readable from JavaScript",
);

// The token in the cookie must be a real session, not a bearer of the user id.
const issuedToken = issued.match(/arbor_session=([^;]+)/)?.[1] ?? "";
const sessionRow = await one(`SELECT user_id FROM sessions WHERE token_hash = $1`, [
  createHash("sha256").update(decodeURIComponent(issuedToken)).digest("hex"),
]);
report(
  "the cookie's token hashes to a session row",
  sessionRow?.user_id ? null : "the issued token matches no session",
);

report(
  "a page loaded with no cookie at all redirects rather than rendering",
  (await fetch("http://localhost:" + PORT + "/", { redirect: "manual" })).status === 307
    ? null
    : "an unauthenticated request rendered the app",
);

console.log("\ncalendar drag → a day, and back\n");

// The calendar's equivalent of the board's drag check: a drop names a day, and
// what lands in Postgres has to be that day at midnight UTC (D-067) — not the
// instant the drop happened, and not the day before in some other zone.
await warm("/calendar");
const CALENDAR_ACTIONS = actionIds("app/calendar/page");
const CALENDAR_URL = "http://localhost:" + PORT + "/calendar";

const scheduled = await one(
  `SELECT id, key, due_at, due_has_time FROM tasks WHERE due_at IS NOT NULL ORDER BY due_at LIMIT 1`,
);
const targetDay = "2026-09-24";

const rescheduled = await callOn(CALENDAR_URL, CALENDAR_ACTIONS.setTaskDate!, [
  scheduled.id,
  "dueAt",
  targetDay,
]);

const afterDrop = await one(`SELECT due_at, due_has_time FROM tasks WHERE id = $1`, [scheduled.id]);
report(
  "a drop puts the task on that day at midnight UTC",
  afterDrop.due_at.toISOString() === `${targetDay}T00:00:00.000Z`
    ? null
    : `stored ${afterDrop.due_at.toISOString()}`,
);

report(
  "and marks it as carrying no time, because a square is a whole day",
  afterDrop.due_has_time === false ? null : "the task still claims to have a time",
);

const dateInverse = rescheduled.text.match(/\[\{"kind":"setField".*?\}\]/);
const dateStack = new UndoStack(20);
dateStack.push(JSON.parse(dateInverse![0]));
await callOn("http://localhost:" + PORT + "/", PAGE_ACTIONS.undo!, [dateStack.pop()]);

const afterUndo = await one(`SELECT due_at FROM tasks WHERE id = $1`, [scheduled.id]);
report(
  "undoing a drag puts the date back",
  afterUndo.due_at.toISOString() === scheduled.due_at.toISOString()
    ? null
    : `expected ${scheduled.due_at.toISOString()}, got ${afterUndo.due_at.toISOString()}`,
);

report(
  "a calendar may not move a field that is not a date",
  (await callOn(CALENDAR_URL, CALENDAR_ACTIONS.setTaskDate!, [scheduled.id, "position", targetDay]))
    .text.includes("may only move a due or start date")
    ? null
    : "a non-date field was accepted",
);

console.log("\ntable columns → the saved view\n");

// The column chooser writes straight to the saved view rather than layering
// over it in the URL (D-066), so this seam — a menu handler to the view
// service — is the only thing standing between a click and a definition. It
// is exactly the shape of seam this file exists for (D-048).
await warm("/table");
const TABLE_ACTIONS = actionIds("app/table/page");
const TABLE_URL = "http://localhost:" + PORT + "/table";

const tableView = await one(`SELECT id, definition FROM views WHERE type = 'table' LIMIT 1`);
const originalDefinition = tableView.definition;

const refused = await callOn(TABLE_URL, TABLE_ACTIONS.saveViewDefinitionAction!, [
  tableView.id,
  { ...originalDefinition, columns: [{ field: "cf:00000000-0000-4000-8000-00000000dead" }] },
]);
const refusedResult = returned(refused.text);
report(
  "a column naming a field that does not exist is refused at the action boundary",
  refusedResult?.ok === false && /column/i.test(refusedResult.error ?? "")
    ? null
    : `got ${JSON.stringify(refusedResult)}`,
);

const untouched = await one(`SELECT definition FROM views WHERE id = $1`, [tableView.id]);
report(
  "and the view it would have broken is unchanged",
  JSON.stringify(untouched.definition) === JSON.stringify(originalDefinition)
    ? null
    : "the refused definition was written anyway",
);

const hidden = originalDefinition.columns.map((column: { field: string }, index: number) =>
  index === 0 ? { ...column, hidden: true } : column,
);
const accepted = await callOn(TABLE_URL, TABLE_ACTIONS.saveViewDefinitionAction!, [
  tableView.id,
  { ...originalDefinition, columns: hidden },
]);
report(
  "hiding a column saves",
  returned(accepted.text)?.ok === true ? null : `got ${accepted.text.slice(0, 120)}`,
);

const afterHide = await one(`SELECT definition FROM views WHERE id = $1`, [tableView.id]);
report(
  "and the hidden column keeps its place in the definition",
  afterHide.definition.columns.length === originalDefinition.columns.length &&
    afterHide.definition.columns[0].hidden === true
    ? null
    : `stored ${JSON.stringify(afterHide.definition.columns.slice(0, 2))}`,
);

await db.query(`UPDATE views SET definition = $1 WHERE id = $2`, [
  originalDefinition,
  tableView.id,
]);

// --- authorization, through the action boundary -----------------------------
//
// `db:smoke` proves the check refuses. This proves the actions *call* it — and
// it is the half that was missing, because every action authenticated and none
// authorized. A check that only asserts the refusal message would pass against
// a server that refused everything, so each one is paired with the same call
// succeeding for someone who may make it, and with Postgres afterwards.
console.log("\nauthorization → an id is not permission\n");

// Sam is a member of the workspace with no grant on the private list, which is
// the case that matters: signed in, legitimate, and not entitled to this row.
const { token: samToken } = await signIn("sam@example.com", "arbor-demo-2026");
const SAM = `arbor_session=${samToken}`;
const samUserId = (await one(`SELECT id FROM users WHERE email = 'sam@example.com'`)).id;

/**
 * Takes a grant away the way a revocation does.
 *
 * Deleting the `grants` row alone leaves `access_index` holding what that grant
 * used to imply — the index is derived, and nothing recomputes it just because
 * its input vanished. A fixture that clears only the grant leaves the next
 * check looking at someone who still has access, which is how the consent check
 * first passed for the wrong reason.
 */
async function revokeHiring(userId: string) {
  const hiring = await one(`SELECT id FROM containers WHERE name = 'Hiring'`);
  await db.query(`DELETE FROM grants WHERE container_id = $1 AND principal_id = $2`, [
    hiring.id,
    userId,
  ]);
  await db.query(`DELETE FROM access_index WHERE list_id = $1 AND principal_id = $2`, [
    hiring.id,
    userId,
  ]);
}

await warm("/settings/sharing");
const SHARING_URL = `http://localhost:${PORT}/settings/sharing`;
const SHARING_ACTIONS = actionIds("app/settings/sharing/page");

const privateTask = await one(`SELECT id, name, status_id FROM tasks WHERE key = 'HIRE-1'`);
report(
  "the private task these checks need exists",
  privateTask?.id ? null : "the seed did not create HIRE-1 — re-run npm run db:seed",
);

const refusedCycle = await callOn(
  "http://localhost:" + PORT + "/",
  PAGE_ACTIONS.cycleStatus!,
  [privateTask.id],
  SAM,
);
const unchangedStatus = await one(`SELECT status_id FROM tasks WHERE id = $1`, [privateTask.id]);
report(
  "a member with no grant cannot cycle a private task's status",
  refusedCycle.text.includes("no longer exists") &&
    unchangedStatus.status_id === privateTask.status_id
    ? null
    : "the write landed, or the refusal named the wrong reason",
);

const refusedRename = await callOn(
  "http://localhost:" + PORT + "/",
  PAGE_ACTIONS.renameTask!,
  [privateTask.id, "Renamed by someone with no access"],
  SAM,
);
const unchangedName = await one(`SELECT name FROM tasks WHERE id = $1`, [privateTask.id]);
report(
  "and cannot rename it",
  refusedRename.text.includes("no longer exists") && unchangedName.name === privateTask.name
    ? null
    : `the name is now "${unchangedName.name}"`,
);

// The widest one: `undo` takes operations from the client, so a hand-built
// batch naming any task at all is the request this most needed to refuse.
await callOn(
  "http://localhost:" + PORT + "/",
  PAGE_ACTIONS.undo!,
  [[{ kind: "setField", taskId: privateTask.id, field: "name", from: privateTask.name, to: "Undone into" }]],
  SAM,
);
const afterForgedUndo = await one(`SELECT name FROM tasks WHERE id = $1`, [privateTask.id]);
report(
  "a hand-built undo batch cannot write to a task the caller cannot reach",
  afterForgedUndo.name === privateTask.name
    ? null
    : `undo wrote "${afterForgedUndo.name}" to a task the caller has no grant on`,
);

// Same call, someone who may make it — or the three above would pass against a
// server that had simply stopped writing.
const allowedRename = await callOn(
  "http://localhost:" + PORT + "/",
  PAGE_ACTIONS.renameTask!,
  [privateTask.id, "Draft the staff engineer offer (edited)"],
);
const ownerRenamed = await one(`SELECT name FROM tasks WHERE id = $1`, [privateTask.id]);
report(
  "the owner, who can reach it, still can",
  allowedRename.status === 200 && ownerRenamed.name.endsWith("(edited)")
    ? null
    : `the owner was refused: ${allowedRename.text.slice(0, 120)}`,
);
await db.query(`UPDATE tasks SET name = $1 WHERE id = $2`, [privateTask.name, privateTask.id]);

// A task Sam *can* reach, to show the refusal is about the grant and not about
// Sam being a second session.
const reachable = await one(`SELECT id, name FROM tasks WHERE key = 'ENG-417'`);
await callOn(
  "http://localhost:" + PORT + "/",
  PAGE_ACTIONS.renameTask!,
  [reachable.id, "Renamed by a member who may"],
  SAM,
);
const memberRenamed = await one(`SELECT name FROM tasks WHERE id = $1`, [reachable.id]);
report(
  "and a member may still edit a task in a list they can reach",
  memberRenamed.name === "Renamed by a member who may"
    ? null
    : `a permitted edit was refused: the name is "${memberRenamed.name}"`,
);
await db.query(`UPDATE tasks SET name = $1 WHERE id = $2`, [reachable.name, reachable.id]);

// Sharing and configuration are administered, not edited (D-081). Sam is a
// member: the strongest thing he holds is `edit` on a container, and none of
// these are scoped to a container at all.
const founders = await one(`SELECT id FROM containers WHERE name = 'Founders'`);

const forgedGrant = await callOn(
  SHARING_URL,
  SHARING_ACTIONS.shareContainerAction!,
  [founders.id, "user", samUserId, "manage"],
  SAM,
);
const grantLanded = await one(
  `SELECT 1 FROM grants WHERE container_id = $1 AND principal_id = $2`,
  [founders.id, samUserId],
);
report(
  "a member cannot grant themselves access to a private space",
  /admin/i.test(forgedGrant.text) && !grantLanded
    ? null
    : grantLanded
      ? "the grant was written — the escalation path is open"
      : `refused, but not as an admin check: ${forgedGrant.text.slice(0, 140)}`,
);

// The escalation this closes, end to end: with the grant refused, the task
// check from D-080 still stands rather than being walked around.
const stillHidden = await callOn(
  "http://localhost:" + PORT + "/",
  PAGE_ACTIONS.renameTask!,
  [privateTask.id, "Renamed after granting myself access"],
  SAM,
);
const stillNamed = await one(`SELECT name FROM tasks WHERE id = $1`, [privateTask.id]);
report(
  "so the task check cannot be walked around by granting first",
  stillHidden.text.includes("no longer exists") && stillNamed.name === privateTask.name
    ? null
    : `the task is now named "${stillNamed.name}"`,
);

const forgedPrivacy = await callOn(
  SHARING_URL,
  SHARING_ACTIONS.setPrivacyAction!,
  [founders.id, false],
  SAM,
);
const stillPrivate = await one(`SELECT is_private FROM containers WHERE id = $1`, [founders.id]);
report(
  "and cannot open a private space by turning privacy off",
  /admin/i.test(forgedPrivacy.text) && stillPrivate.is_private === true
    ? null
    : "the space was opened",
);

const forgedStatus = await callOn(
  PAGE,
  IDS.createStatusSetAction!,
  [`Forged ${Date.now()}`, "simple", null],
  SAM,
);
report(
  "a member cannot create a workspace status set",
  /admin/i.test(forgedStatus.text) ? null : `got ${forgedStatus.text.slice(0, 140)}`,
);

// The owner is checked on the same call, so none of the above can be passing
// because the server stopped writing.
const allowedPrivacy = await callOn(SHARING_URL, SHARING_ACTIONS.setPrivacyAction!, [
  founders.id,
  true,
]);
report(
  "an admin may still change privacy",
  returned(allowedPrivacy.text)?.ok === true
    ? null
    : `the owner was refused: ${allowedPrivacy.text.slice(0, 140)}`,
);

// --- the task detail page --------------------------------------------------
//
// The page's own security property first, because it is the reason the route
// needed D-080: an id in a URL is something anyone can type. Then the four
// actions it introduced, each of which writes through the operation layer and
// therefore has to produce an activity row and an inverse that works.
console.log("\ntask detail → the page and its actions\n");

const pageAsSam = await fetch(`http://localhost:${PORT}/t/HIRE-1`, { headers: { Cookie: SAM } });
const samSaw = await pageAsSam.text();
report(
  "the detail page does not render a task the viewer cannot reach",
  samSaw.includes("No such task") && !samSaw.includes("Draft the staff engineer offer")
    ? null
    : "a private task was rendered to a member with no grant",
);

const pageAsOwner = await fetch(`http://localhost:${PORT}/t/HIRE-1`, { headers: { Cookie: COOKIE } });
const ownerSaw = await pageAsOwner.text();
report(
  "and does render it to someone who can",
  ownerSaw.includes("Draft the staff engineer offer")
    ? null
    : "the owner was shown nothing — the check refuses everyone",
);

// A key that does not exist and a task that is not yours have to be the same
// page, or the route is an existence oracle for every private list.
const missing = await fetch(`http://localhost:${PORT}/t/NOPE-1`, { headers: { Cookie: SAM } });
const missingSaw = await missing.text();
report(
  "a key that never existed is the same page as one you may not see",
  missingSaw.includes("No such task") ? null : "a missing task rendered something else",
);

await warm("/t/ENG-415");
const DETAIL_URL = `http://localhost:${PORT}/t/ENG-415`;
const DETAIL_ACTIONS = actionIds("app/t/[key]/page");

const detailTask = await one(`SELECT id, status_id, task_type_id FROM tasks WHERE key = 'ENG-415'`);
const targetStatus = await one(
  `SELECT s.id FROM statuses s
   JOIN status_sets ss ON ss.id = s.status_set_id
   WHERE ss.name = 'Engineering' AND s.name = 'In Review'`,
);

const picked = await callOn(DETAIL_URL, DETAIL_ACTIONS.setTaskStatus!, [
  detailTask.id,
  targetStatus.id,
]);
const afterPick = await one(`SELECT status_id FROM tasks WHERE id = $1`, [detailTask.id]);
report(
  "picking a status on the detail page moves the task",
  afterPick.status_id === targetStatus.id ? null : "the status did not change",
);

// Same operation as the list's cycling, so the same stack has to undo it.
const statusInverse = picked.text.match(/\[\{"kind":"setField".*?\}\]/);
const statusStack = new UndoStack(20);
statusStack.push(JSON.parse(statusInverse![0]));
await callOn("http://localhost:" + PORT + "/", PAGE_ACTIONS.undo!, [statusStack.pop()]);
const afterStatusUndo = await one(`SELECT status_id FROM tasks WHERE id = $1`, [detailTask.id]);
report(
  "and undo puts it back, through the same stack the list uses",
  afterStatusUndo.status_id === detailTask.status_id ? null : "the status did not go back",
);

// A status from another set would make the task vanish from its own board.
const foreignStatus = await one(
  `SELECT s.id FROM statuses s
   JOIN status_sets ss ON ss.id = s.status_set_id
   WHERE ss.name = 'Default' AND s.name = 'Doing'`,
);
const refusedStatus = await callOn(DETAIL_URL, DETAIL_ACTIONS.setTaskStatus!, [
  detailTask.id,
  foreignStatus.id,
]);
const unmoved = await one(`SELECT status_id FROM tasks WHERE id = $1`, [detailTask.id]);
report(
  "a status from another set is refused, not written",
  refusedStatus.text.includes("does not belong") && unmoved.status_id === detailTask.status_id
    ? null
    : "a foreign status was accepted",
);

// RelationOp has been in the union since Phase 3 with nothing calling it.
const jordan = await one(`SELECT id FROM users WHERE email = 'jordan@example.com'`);
const assigned = await callOn(DETAIL_URL, DETAIL_ACTIONS.setTaskRelation!, [
  detailTask.id,
  "assignee",
  jordan.id,
  true,
]);
const nowAssigned = await one(
  `SELECT 1 FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
  [detailTask.id, jordan.id],
);
const assignActivity = await one(
  `SELECT verb FROM activity WHERE object_id = $1 ORDER BY at DESC LIMIT 1`,
  [detailTask.id],
);
report(
  "assigning someone writes the row and the activity",
  nowAssigned && assignActivity.verb === "task.assignee_added"
    ? null
    : `logged ${assignActivity?.verb}`,
);

const relationStack = new UndoStack(20);
relationStack.push(JSON.parse(assigned.text.match(/\[\{"kind":"removeRelation".*?\}\]/)![0]));
await callOn("http://localhost:" + PORT + "/", PAGE_ACTIONS.undo!, [relationStack.pop()]);
const stillAssigned = await one(
  `SELECT 1 FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
  [detailTask.id, jordan.id],
);
report(
  "and undoing the assignment removes it again",
  !stillAssigned ? null : "the assignee survived an undo",
);

// The typed column matters: a number in value_text is a value no filter will
// ever find again (D-042), and only the executor knows which column is right.
const points = await one(`SELECT id FROM fields WHERE name = 'Story Points'`);
await callOn(DETAIL_URL, DETAIL_ACTIONS.setCustomFieldValue!, [detailTask.id, points.id, 13]);
const storedPoints = await one(
  `SELECT value_num, value_text FROM field_values WHERE task_id = $1 AND field_id = $2`,
  [detailTask.id, points.id],
);
report(
  "a custom field value lands in the column its type declares",
  Number(storedPoints.value_num) === 13 && storedPoints.value_text === null
    ? null
    : `stored num=${storedPoints.value_num} text=${storedPoints.value_text}`,
);

const refusedType = await callOn(DETAIL_URL, DETAIL_ACTIONS.setCustomFieldValue!, [
  detailTask.id,
  points.id,
  "not a number",
]);
const unchangedPoints = await one(
  `SELECT value_num FROM field_values WHERE task_id = $1 AND field_id = $2`,
  [detailTask.id, points.id],
);
report(
  "and a value the field's type refuses is not written",
  Number(unchangedPoints.value_num) === 13 && !/"ok":true/.test(refusedType.text)
    ? null
    : "a bad value reached the column",
);

// Sam can reach ENG-415, so this is about the rung and not about the grant.
const samPicks = await callOn(
  DETAIL_URL,
  DETAIL_ACTIONS.setTaskRelation!,
  [privateTask.id, "assignee", jordan.id, true],
  SAM,
);
const forgedAssign = await one(
  `SELECT 1 FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
  [privateTask.id, jordan.id],
);
report(
  "the panel's actions are scoped like every other write",
  samPicks.text.includes("no longer exists") && !forgedAssign
    ? null
    : "an assignee was written to a task the caller cannot reach",
);

// --- comments ---------------------------------------------------------------
//
// The mention-consent flow is the reason this section exists. It is a
// *permission change reached through a comment box*, which is the kind of thing
// that has to be impossible by accident — so what is asserted is that the first
// call writes nothing at all, and that the second grants on the list rather
// than the space.
console.log("\ncomments → posting, mentions and consent\n");

const commentedTask = await one(`SELECT id FROM tasks WHERE key = 'ENG-390'`);
await db.query(`DELETE FROM comments WHERE object_id = $1`, [commentedTask.id]);

const posted = await callOn(DETAIL_URL, DETAIL_ACTIONS.postComment!, [
  commentedTask.id,
  "Looks right to me, @Riley Kaur",
  null,
  false,
]);
const storedComment = await one(
  `SELECT body, author_id FROM comments WHERE object_id = $1`,
  [commentedTask.id],
);
report(
  "a comment posted from the panel reaches the table",
  storedComment?.author_id ? null : `nothing was written: ${posted.text.slice(0, 140)}`,
);

// The mention is a node with an id, which is why the format is a tree at all.
report(
  "and its mention is a reference rather than the characters that were typed",
  JSON.stringify(storedComment.body).includes(`"type":"mention"`)
    ? null
    : `stored ${JSON.stringify(storedComment.body).slice(0, 140)}`,
);

// Commenting is joining a conversation, which is a clearer opt-in than
// anything the system could infer.
const nowWatching = await one(
  `SELECT 1 FROM task_watchers w JOIN users u ON u.id = w.user_id
   WHERE w.task_id = $1 AND u.email = 'avery@example.com'`,
  [commentedTask.id],
);
report("commenting makes you a watcher", nowWatching ? null : "the author is not watching");

// The consent flow. Sam has no grant on the private list, so mentioning him
// there must refuse and write nothing — not the comment, and not the grant.
await revokeHiring(samUserId);
await db.query(`DELETE FROM comments WHERE object_id = $1`, [privateTask.id]);

const blocked = await callOn(DETAIL_URL, DETAIL_ACTIONS.postComment!, [
  privateTask.id,
  "Take a look, @Sam Petrov",
  null,
  false,
]);
const nothingPosted = await one(`SELECT 1 FROM comments WHERE object_id = $1`, [privateTask.id]);
const nothingGranted = await one(
  `SELECT 1 FROM grants g JOIN containers c ON c.id = g.container_id
   WHERE c.name = 'Hiring' AND g.principal_id = $1`,
  [samUserId],
);
report(
  "mentioning someone who cannot see the task writes nothing and asks",
  /needsConsent/.test(blocked.text) && !nothingPosted && !nothingGranted
    ? null
    : nothingGranted
      ? "a grant was written without consent"
      : `no consent was asked for: ${blocked.text.slice(0, 160)}`,
);

// The same call with consent. The grant must land on the list, not the space —
// mentioning someone on one task should not open every other list in it.
await callOn(DETAIL_URL, DETAIL_ACTIONS.postComment!, [
  privateTask.id,
  "Take a look, @Sam Petrov",
  null,
  true,
]);
const grantedOn = await one(
  `SELECT c.name, c.kind FROM grants g JOIN containers c ON c.id = g.container_id
   WHERE g.principal_id = $1`,
  [samUserId],
);
report(
  "consenting grants view on the list, not on the space above it",
  grantedOn?.name === "Hiring" && grantedOn.kind === "list"
    ? null
    : `granted on ${grantedOn?.name} (${grantedOn?.kind})`,
);

const spaceStillClosed = await one(
  `SELECT is_private FROM containers WHERE name = 'Founders'`,
);
report(
  "and leaves the private space private",
  spaceStillClosed.is_private === true ? null : "the space was opened",
);

// Riley can reach the private list but is not an admin, so consent cannot help.
const { token: rileyToken } = await signIn("riley@example.com", "arbor-demo-2026");
const RILEY = `arbor_session=${rileyToken}`;
await revokeHiring(samUserId);

const cannotShare = await callOn(
  DETAIL_URL,
  DETAIL_ACTIONS.postComment!,
  [privateTask.id, "Adding @Sam Petrov", null, true],
  RILEY,
);
const rileyGranted = await one(
  `SELECT 1 FROM grants g JOIN containers c ON c.id = g.container_id
   WHERE c.name = 'Hiring' AND g.principal_id = $1`,
  [samUserId],
);
report(
  "a member is told they cannot share rather than being asked to",
  /"canShare":false/.test(cannotShare.text)
    ? null
    : `expected canShare:false, got ${cannotShare.text.slice(0, 160)}`,
);
report(
  "and no grant is written on their behalf",
  !rileyGranted ? null : "a non-admin granted access through a comment box",
);

// Editing is the author's, not an editor's: Riley has edit on this list and
// still may not rewrite what Avery said.
const averyComment = await one(
  `SELECT id FROM comments WHERE object_id = $1 ORDER BY created_at LIMIT 1`,
  [privateTask.id],
);
const refusedEdit = await callOn(
  DETAIL_URL,
  DETAIL_ACTIONS.editComment!,
  [averyComment.id, "Something else entirely"],
  RILEY,
);
const unedited = await one(`SELECT body FROM comments WHERE id = $1`, [averyComment.id]);
report(
  "someone with edit on the list cannot rewrite another person's comment",
  /Only the author/.test(refusedEdit.text) &&
    !JSON.stringify(unedited.body).includes("Something else entirely")
    ? null
    : "a comment was rewritten by someone who did not write it",
);

// A comment is an operation, so its inverse deletes it — soft, so the reply
// under a deleted comment keeps its anchor.
const deletable = await callOn(DETAIL_URL, DETAIL_ACTIONS.postComment!, [
  commentedTask.id,
  "Temporary",
  null,
  false,
]);
const newId = deletable.text.match(/"kind":"deleteComment","commentId":"([0-9a-f-]{36})"/);
report(
  "posting returns an inverse that deletes it",
  newId ? null : `no inverse came back: ${deletable.text.slice(0, 160)}`,
);

await callOn("http://localhost:" + PORT + "/", PAGE_ACTIONS.undo!, [
  [{ kind: "deleteComment", commentId: newId![1], taskId: commentedTask.id }],
]);
const softDeleted = await one(`SELECT deleted_at FROM comments WHERE id = $1`, [newId![1]]);
report(
  "and undoing it soft-deletes rather than removing the row",
  softDeleted?.deleted_at !== null ? null : "the comment is still live",
);

const description = await callOn(DETAIL_URL, DETAIL_ACTIONS.setTaskDescription!, [
  commentedTask.id,
  "What it does.\n\nAnd why.",
]);
const describedTask = await one(`SELECT description FROM tasks WHERE id = $1`, [commentedTask.id]);
report(
  "a description is stored as the same document a comment is",
  JSON.stringify(describedTask.description).includes('"type":"paragraph"') &&
    description.status === 200
    ? null
    : `stored ${JSON.stringify(describedTask.description).slice(0, 140)}`,
);

// --- the inbox --------------------------------------------------------------
//
// The screen the fan-out was written for, and the first one not scoped to a
// container. Two properties matter here. The container scoping used to give the
// second one for free: a notification row is a record that something happened,
// not a licence to see it — so it appears in one person's inbox and in nobody
// else's, and an id someone else holds does not clear it.
//
// Nothing below inserts a fixture. The rows come from Riley naming Avery in a
// real comment, because the fan-out runs inside that transaction and a hand-
// written row would not prove it does.
console.log("\ninbox → what is mine, anywhere\n");

await db.query(`DELETE FROM notifications`);

const averyId = (await one(`SELECT id FROM users WHERE email = 'avery@example.com'`)).id;

await callOn(
  DETAIL_URL,
  DETAIL_ACTIONS.postComment!,
  [detailTask.id, "Can you take this one, @Avery Mills?", null, false],
  RILEY,
);

const notified = await one(
  `SELECT id, kind, is_read FROM notifications WHERE user_id = $1`,
  [averyId],
);
report(
  "a mention posted by someone else puts a row in the mentioned person's inbox",
  notified?.kind === "mentioned" ? null : `wrote ${notified?.kind ?? "nothing"}`,
);

await warm("/inbox");
const INBOX_URL = `http://localhost:${PORT}/inbox`;
const INBOX_ACTIONS = actionIds("app/inbox/page");

const inboxAsAvery = await (await fetch(INBOX_URL, { headers: { Cookie: COOKIE } })).text();
report(
  "the inbox renders it, from the payload rather than a join",
  inboxAsAvery.includes("Riley Kaur mentioned you") && inboxAsAvery.includes("ENG-415")
    ? null
    : "the page did not show the notification",
);

// The badge is in the shell of every screen, so it is checked on a page that is
// not the inbox — that is where it would go stale.
const listAsAvery = await (await fetch(`http://localhost:${PORT}/`, { headers: { Cookie: COOKIE } })).text();
report(
  "and the sidebar badge counts it on every other screen",
  /data-unread="true">1</.test(listAsAvery) ? null : "the badge is not the real count",
);

const inboxAsSam = await (await fetch(INBOX_URL, { headers: { Cookie: SAM } })).text();
report(
  "someone else's inbox does not contain it",
  !inboxAsSam.includes("mentioned you") ? null : "a notification leaked into another inbox",
);

await callOn(INBOX_URL, INBOX_ACTIONS.markNotificationRead!, [notified.id]);
report(
  "opening a row marks it read",
  (await one(`SELECT is_read FROM notifications WHERE id = $1`, [notified.id])).is_read === true
    ? null
    : "the row is still unread",
);

// An id is not permission — the same rule the detail page needed (D-080), and
// here it is enforced by the query's own scoping rather than by a refusal.
await db.query(`UPDATE notifications SET is_read = false, read_at = NULL WHERE id = $1`, [
  notified.id,
]);
await callOn(INBOX_URL, INBOX_ACTIONS.markNotificationRead!, [notified.id], SAM);
report(
  "an id belonging to someone else clears nothing",
  (await one(`SELECT is_read FROM notifications WHERE id = $1`, [notified.id])).is_read === false
    ? null
    : "someone else marked it read",
);

const malformed = await callOn(INBOX_URL, INBOX_ACTIONS.markNotificationRead!, ["not-a-uuid"]);
report(
  "a malformed id comes back as a sentence rather than a Postgres error",
  /no longer exists/.test(malformed.text) && !/invalid input syntax/.test(malformed.text)
    ? null
    : `got ${malformed.text.slice(0, 160)}`,
);

// Two rows, so "all" means more than "the one".
await callOn(
  DETAIL_URL,
  DETAIL_ACTIONS.postComment!,
  [detailTask.id, "And this too, @Avery Mills", null, false],
  RILEY,
);
const beforeClearing = await one(
  `SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND is_read = false`,
  [averyId],
);
await callOn(INBOX_URL, INBOX_ACTIONS.markEverythingRead!, []);
const afterClearing = await one(
  `SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND is_read = false`,
  [averyId],
);
report(
  "mark all read clears the whole inbox, not the page of it that was rendered",
  beforeClearing.n === "2" && afterClearing.n === "0"
    ? null
    : `${beforeClearing.n} unread before, ${afterClearing.n} after`,
);

await db.query(`DELETE FROM notifications`);
await db.query(`DELETE FROM comments WHERE object_id = $1`, [detailTask.id]);

// --- the inbox's other half -------------------------------------------------
//
// Ambient activity is assembled at read time from `activity`, so there is no
// row to inspect and the page *is* the assertion: what a watcher sees, and what
// the badge deliberately does not count.
console.log("\nwatched activity → assembled, counted separately\n");

await db.query(
  `INSERT INTO task_watchers (task_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
  [detailTask.id, averyId],
);
await db.query(`UPDATE memberships SET activity_seen_at = NULL WHERE user_id = $1`, [averyId]);

// Riley moves the task Avery is watching. A real action, so the activity row is
// written by the same path the app writes every other one.
const reviewStatus = await one(
  `SELECT s.id FROM statuses s JOIN status_sets ss ON ss.id = s.status_set_id
   WHERE ss.name = 'Engineering' AND s.name = 'In Review'`,
);
await callOn(DETAIL_URL, DETAIL_ACTIONS.setTaskStatus!, [detailTask.id, reviewStatus.id], RILEY);

// Matched loosely on purpose. The summary is one sentence over whatever the
// group holds, so asserting the exact words would be asserting how much other
// activity this task happened to collect — "changed status" becomes "changed a
// custom field and status" the moment another check touches the same task.
const watchedLine = /Riley Kaur[^<]*\bstatus\b/;

const withAmbient = await (await fetch(INBOX_URL, { headers: { Cookie: COOKIE } })).text();
report(
  "a change on a task you watch is assembled into the inbox",
  watchedLine.test(withAmbient) ? null : "the watched change never appeared",
);

// The badge is a count of things addressed to you. Ambient activity is a feed
// you visit, and a badge that counted it would be large, ignorable, ignored.
const listAgain = await (await fetch(`http://localhost:${PORT}/`, { headers: { Cookie: COOKIE } })).text();
report(
  "and is not counted by the badge, which is for what names you",
  !/data-unread/.test(listAgain) ? null : "ambient activity reached the badge",
);

// One button, both halves: a flag per row for the signals, one timestamp for
// the feed. The difference is the schema's, not the reader's.
await callOn(INBOX_URL, INBOX_ACTIONS.markEverythingRead!, []);
const mark = await one(`SELECT activity_seen_at FROM memberships WHERE user_id = $1`, [averyId]);
const afterMark = await (await fetch(INBOX_URL, { headers: { Cookie: COOKIE } })).text();
report(
  "mark all read moves the feed's mark, not just the unread flags",
  mark.activity_seen_at !== null && !watchedLine.test(afterMark)
    ? null
    : mark.activity_seen_at === null
      ? "the mark was not written"
      : "the feed still shows what was marked seen",
);

// The window is not the mark: "everything" ignores how far you have read, so a
// cleared feed is still readable rather than gone.
const everything = await (
  await fetch(`${INBOX_URL}?all=1`, { headers: { Cookie: COOKIE } })
).text();
report(
  "and everything still shows what was cleared",
  watchedLine.test(everything) ? null : "clearing the feed hid it for good",
);

await db.query(`DELETE FROM task_watchers WHERE task_id = $1 AND user_id = $2`, [
  detailTask.id,
  averyId,
]);
await db.query(`UPDATE memberships SET activity_seen_at = NULL WHERE user_id = $1`, [averyId]);
// Put the status back. The earlier checks move this same task *to* In Review
// and assert the operation was not a no-op, so leaving it there makes the next
// run of this script fail somewhere else entirely.
await db.query(`UPDATE tasks SET status_id = $2 WHERE id = $1`, [
  detailTask.id,
  detailTask.status_id,
]);

// --- history on the page ----------------------------------------------------
//
// The log has been written to since Phase 2 and this is the first screen that
// reads it. What matters through the action boundary is that an action taken
// now is on the page a moment later, in words rather than in ids.
console.log("\ntask history → what an action leaves behind\n");

const historyStatus = await one(
  `SELECT s.id, s.name FROM statuses s JOIN status_sets ss ON ss.id = s.status_set_id
   WHERE ss.name = 'Engineering' AND s.name = 'Done'`,
);
const beforeHistory = await one(`SELECT status_id FROM tasks WHERE id = $1`, [detailTask.id]);

await callOn(DETAIL_URL, DETAIL_ACTIONS.setTaskStatus!, [detailTask.id, historyStatus.id]);
const detailPage = await (await fetch(DETAIL_URL, { headers: { Cookie: COOKIE } })).text();

report(
  "an action shows up in the task's history, named and attributed",
  /Avery Mills[^<]*<\/span>\s*<span class="history-what">changed status/.test(detailPage) ||
    (detailPage.includes("history-what") && detailPage.includes("changed status"))
    ? null
    : "the history did not show the change",
);

// Ids are what the log stores; names are what the page owes the reader.
report(
  "and reads the ids back as the words on the page",
  detailPage.includes(`>${historyStatus.name}<`) && !detailPage.includes(`>${historyStatus.id}<`)
    ? null
    : "a raw id reached the screen",
);

await callOn(DETAIL_URL, DETAIL_ACTIONS.setTaskStatus!, [detailTask.id, beforeHistory.status_id]);

// --- the live stream --------------------------------------------------------
//
// The first route handler in the app, and the only place a change meets a
// viewer before it leaves the server. So the check that matters is not "does a
// nudge arrive" — it is that the *same* change reaches one stream and not the
// other. A stream that told anyone with a session that something changed in a
// list they cannot open would be an existence oracle with a keep-alive (D-090).
console.log("\nlive stream → the same change, two viewers, one of them told\n");

async function openStream(cookie: string, query = "") {
  const controller = new AbortController();
  const response = await fetch(`http://localhost:${PORT}/api/live${query}`, {
    headers: { Cookie: cookie },
    signal: controller.signal,
  });

  const text: string[] = [];
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text.push(decoder.decode(value, { stream: true }));
        }
      } catch {
        // Aborted by close(), which is how these end.
      }
    })();
  }

  return {
    status: response.status,
    heard: () => text.join(""),
    close: () => controller.abort(),
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const anonymous = await fetch(`http://localhost:${PORT}/api/live`);
report(
  "the stream refuses a request with no session",
  anonymous.status === 401 ? null : `got ${anonymous.status}`,
);
await anonymous.body?.cancel();

// Sam has no grant on Hiring; Avery owns the workspace and can see everything.
await revokeHiring(samUserId);

const averyStream = await openStream(COOKIE);
const samStream = await openStream(SAM);
await pause(300);

report(
  "a signed-in viewer gets a stream that opens",
  averyStream.status === 200 && /event: ready/.test(averyStream.heard())
    ? null
    : `status ${averyStream.status}, heard "${averyStream.heard().slice(0, 80)}"`,
);

// One change, in the private list, made by someone who can reach it.
await callOn(
  DETAIL_URL,
  DETAIL_ACTIONS.postComment!,
  [privateTask.id, "Checking the wire.", null, false],
  RILEY,
);
await pause(900);

const hiringList = (
  await one(`SELECT home_list_id FROM tasks WHERE id = $1`, [privateTask.id])
).home_list_id;

report(
  "it reaches the viewer who can open the list",
  averyStream.heard().includes(`"l":"${hiringList}"`)
    ? null
    : `heard "${averyStream.heard().slice(0, 200)}"`,
);

report(
  "and never reaches the one who cannot",
  !/data: \{"w"/.test(samStream.heard())
    ? null
    : `a private list leaked through the stream: "${samStream.heard().slice(0, 200)}"`,
);

averyStream.close();
samStream.close();
await db.query(`DELETE FROM comments WHERE object_id = $1`, [privateTask.id]);

// --- presence ---------------------------------------------------------------
//
// Presence is the set of open streams, so the checks are about connections
// rather than rows: opening one on a task makes you visible to the people
// already there, closing it makes you gone, and asking about a task you cannot
// open tells you nothing at all.
console.log("\npresence → the connection is the signal\n");

const onTask = async (cookie: string, taskId: string) =>
  openStream(`${cookie}`, `?scope=${encodeURIComponent(taskId)}`);

// Avery arrives first and sees nobody; Riley arrives second, and Avery is told.
const averyHere = await onTask(COOKIE, detailTask.id);
await pause(400);
report(
  "the first person on a task is told about nobody",
  /event: presence/.test(averyHere.heard()) && /"people":\[\]/.test(averyHere.heard())
    ? null
    : `heard "${averyHere.heard().slice(0, 200)}"`,
);

const rileyHere = await onTask(RILEY, detailTask.id);
await pause(600);
report(
  "a second arrival is pushed to the first, by name",
  averyHere.heard().includes("Riley Kaur") ? null : "the arrival was not announced",
);

// Closing the stream is leaving. Nothing sweeps, nothing times out.
rileyHere.close();
await pause(700);
const afterLeaving = averyHere.heard();
report(
  "and closing the connection is leaving, with nothing to sweep",
  afterLeaving.lastIndexOf('"people":[]') > afterLeaving.indexOf("Riley Kaur")
    ? null
    : "the departure was never announced",
);

// A scope is a task, and asking about one you cannot open must not answer.
await revokeHiring(samUserId);
const samPeeking = await onTask(SAM, privateTask.id);
const averyOnPrivate = await onTask(COOKIE, privateTask.id);
await pause(700);
report(
  "asking to watch a task you cannot open registers nothing",
  !/event: presence/.test(samPeeking.heard()) &&
    !averyOnPrivate.heard().includes("Sam Petrov")
    ? null
    : "presence answered for a task the viewer cannot reach",
);

averyHere.close();
samPeeking.close();
averyOnPrivate.close();


await db.query(`DELETE FROM comments WHERE object_id = ANY($1::uuid[])`, [
  [commentedTask.id, privateTask.id],
]);
await db.query(`UPDATE tasks SET description = NULL WHERE id = $1`, [commentedTask.id]);
await revokeHiring(samUserId);

await db.query(`DELETE FROM status_sets WHERE id = $1`, [set.id]);
await db.query(`DELETE FROM fields WHERE name = $1 OR name LIKE 'Bad %'`, [fieldName]);
await db.end();

console.log(failures === 0 ? "\nall action checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
