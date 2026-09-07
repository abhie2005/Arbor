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

await db.query(`DELETE FROM status_sets WHERE id = $1`, [set.id]);
await db.query(`DELETE FROM fields WHERE name = $1 OR name LIKE 'Bad %'`, [fieldName]);
await db.end();

console.log(failures === 0 ? "\nall action checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
