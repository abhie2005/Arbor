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
 *   npx next dev -p 3100        # in apps/web
 *   npm run check:actions -- 3100
 */
import { UndoStack } from "@arbor/core";
import { readFileSync } from "node:fs";
import { Client } from "pg";

const PORT = process.argv[2] ?? "3100";
const PAGE = `http://localhost:${PORT}/settings/statuses`;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://arbor:arbor@localhost:5432/arbor";

/**
 * Action ids are content hashes Next assigns at build time, so they cannot be
 * hard-coded. The compiled server bundle carries the id-to-export mapping in a
 * url-encoded manifest string; this reads it out of the dev build.
 */
function actionIds(route = "app/settings/statuses/page"): Record<string, string> {
  const bundle = `.next/server/${route}.js`;
  let source;
  try {
    source = readFileSync(bundle, "utf8");
  } catch {
    throw new Error(
      `${bundle} not found. Start the dev server and load /settings/statuses once first.`,
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

async function callOn(url: string, id: string, args: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8" },
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

await db.query(`DELETE FROM status_sets WHERE id = $1`, [set.id]);
await db.query(`DELETE FROM fields WHERE name = $1 OR name LIKE 'Bad %'`, [fieldName]);
await db.end();

console.log(failures === 0 ? "\nall action checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
