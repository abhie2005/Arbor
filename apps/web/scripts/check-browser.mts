/**
 * Drives the app in a real browser, as more than one person, in a zone that is
 * not the server's.
 *
 * **Why this exists as a gate rather than as a write-up.** Every other check in
 * this repo runs on the server side of the wire, and three kinds of defect are
 * structurally invisible from there:
 *
 * 1. **A hydration mismatch is a console warning and nothing else** (D-121,
 *    D-132). The HTML is right, the hydrated DOM is right, and React threw the
 *    tree away in between. No HTTP assertion can see it.
 * 2. **Every other gate names the workspace it means** — `db:smoke` passes an
 *    id, `check:api` holds a token that carries one, `check:actions` looks one
 *    up by slug the way the app used to. The only reader that has to *infer*
 *    which workspace it is in is a screen, which is how `requireWorkspace()`
 *    stayed hard-coded to `northwind` for five phases (D-137).
 * 3. **Nothing asked what a screen should *not* say.** The sidebar rendered a
 *    row reading `Backlog` that was a string in the JSX rather than a query; it
 *    looked like the tree in the one reachable workspace and read as a phantom
 *    list in the other. Every assertion in the repo was happy, including the
 *    ones written that same hour about that sidebar, because they all ask
 *    whether the right things are present.
 *
 * Browser passes have found six bugs across two sessions on exactly these three
 * shapes, and until now the pass was a script in a scratch directory that died
 * with the session — so what survived was the write-up in `docs/HISTORY.md` and
 * not the ability to run it again. This file is that pass, kept.
 *
 * **The browser is the one already on the machine** (`playwright-core` plus
 * `channel: "chrome"`), which is the whole reason this can be a dependency at
 * all. `playwright` no longer downloads a browser on install as of 1.39, but it
 * still carries the downloader and expects a `playwright install` step that
 * would put ~130MB behind `npm install` for anybody cloning this repo.
 * `playwright-core` has no install script and no browsers, so `npm ci` — on a
 * laptop and in the Dockerfile's `deps` stage alike — is unchanged, and the
 * thing being driven is the browser the product is actually used in. Point it
 * somewhere else with `ARBOR_CHROME=/path/to/binary` (D-144).
 *
 * Like `check:search` and `check:api`, and unlike `check:actions`, this needs
 * nothing a dev build emits — it clicks what a person clicks. So it runs
 * against anything that serves the app:
 *
 *   npm run check:browser              # localhost:3000
 *   npm run check:browser -- 3300      # or a port
 *   BASE_URL=https://arbor.example npm run check:browser
 *
 * **The server must not be in the browser's zone**, or the half of this that is
 * about zones proves nothing. The container image is alpine and therefore UTC
 * (see the `TZ` trap in CLAUDE.md), which is what you want; a host dev server
 * needs `TZ=UTC` in front of it. The browser is pinned to
 * `America/Los_Angeles` below, so against a UTC server the two disagree about
 * what day it is for several hours out of every day — and the fixture this
 * script writes makes them disagree for all of them.
 *
 * It needs the seeded demo workspace, because the identities *are* the subject:
 * Quinn is in Meridian and nothing else, Avery is in Northwind and nothing
 * else, and Sam is in both.
 */
import { signIn } from "@arbor/db";
import { type Browser, type BrowserContext, chromium } from "playwright-core";
import { Client } from "pg";

const PORT = process.argv[2] ?? process.env.PORT ?? "3000";
const BASE = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://arbor:arbor@localhost:5432/arbor";
const PASSWORD = "arbor-demo-2026";

/**
 * The viewer's zone. Pacific against a UTC server, because that is the pairing
 * D-121 and D-132 were actually wrong in, and because it is behind UTC — a zone
 * ahead of it would make the *server* show the later day and the assertions
 * below would read backwards.
 */
const VIEWER_ZONE = "America/Los_Angeles";

let failures = 0;

function report(label: string, problem: string | null) {
  if (problem) {
    failures += 1;
    console.log(`  FAIL  ${label}\n        ${problem}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

/**
 * A check that this server cannot answer, said out loud rather than counted.
 *
 * There is exactly one: the dev user switcher only renders when
 * `devAuthEnabled()`, so against a production build the control is legitimately
 * absent. Printing a line is the point — a gate that silently drops a check
 * when the environment changes is a gate that reports green for the wrong
 * reason.
 */
function skip(label: string, why: string) {
  console.log(`  skip  ${label}\n        ${why}`);
}

/**
 * A group of checks that cannot take the rest of the run down with it.
 *
 * Found by reverting D-137 to prove this gate catches it: the resolver answered
 * "no workspace", three checks failed correctly, and then reading
 * `aside.sidebar` threw because a page showing "No demo workspace yet" has no
 * shell — which aborted the process and hid the twenty-seven checks after it.
 * A gate is most useful on the run where something is broken, which is exactly
 * the run where a locator is most likely to find nothing, so a section that
 * blows up is one more failure rather than the end of the report.
 */
async function section(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    report(`${label} — the section got this far and threw`, (e as Error).message.split("\n")[0]);
  }
}

/**
 * `innerText`, or the empty string if the element never turns up.
 *
 * Every content assertion below is a `.includes()`, so an element that is
 * missing and an element that says the wrong thing should read the same way to
 * the check: a failure naming what it wanted. Letting the locator throw instead
 * turns the most informative run into a stack trace.
 */
async function textOf(locator: { innerText: (o?: { timeout?: number }) => Promise<string> }) {
  try {
    return await locator.innerText({ timeout: 10_000 });
  } catch {
    return "";
  }
}

/**
 * Timeouts, because the alternative is a gate that hangs instead of failing.
 *
 * Colima's ssh port forward is the only route from this machine to `arbor-pg`,
 * and it stalls occasionally: `nc -z` still succeeds because the listener
 * accepts, and then the connection never completes. Without
 * `connectionTimeoutMillis` that is an infinite wait with **no output at all**,
 * because the first thing this script does is talk to the database and the
 * first `console.log` is after it — which is exactly how it presented, as a
 * browser gate that appeared to hang in the browser. `lock_timeout` is the same
 * argument for the fixture write below.
 */
const db = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 15_000 });
try {
  await db.connect();
} catch (e) {
  console.log(
    `\n  Could not reach Postgres at ${DATABASE_URL.replace(/:[^:@]*@/, ":***@")}: ${(e as Error).message}\n` +
      `  On this machine that is usually Colima's port forward rather than the database —\n` +
      `  \`docker context use colima && docker ps\` should show arbor-pg, and a stalled\n` +
      `  forward clears with \`colima restart\`.\n`,
  );
  process.exit(1);
}
await db.query(`SET lock_timeout = '15s'`);
const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

/**
 * The page as a person reads it.
 *
 * `<!-- -->` has to go before the markup does: React separates adjacent text
 * nodes with it in server HTML, so `acting as {viewer.name}` never matches as
 * the sentence it reads as. Three checks written for `check:actions` failed
 * against correct code on exactly this.
 */
function words(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** What a due date should read as in a given zone — the same call `dueLabel` makes. */
function label(iso: string, zone: string, format: "weekday" | "month"): string {
  const shape =
    format === "weekday"
      ? { weekday: "short" as const, day: "numeric" as const }
      : { day: "numeric" as const, month: "short" as const };
  return new Intl.DateTimeFormat("en-GB", { ...shape, timeZone: zone }).format(new Date(iso));
}

async function serverHtml(path: string, cookie: string): Promise<string> {
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
 * Console output that is worth failing over.
 *
 * Errors and warnings only: Next's dev build prints an `info` inviting you to
 * install the React DevTools on every page, and a gate that goes red on it is a
 * gate somebody turns off. A hydration mismatch is an `error` in development
 * and in production alike, which is the one this is really watching for.
 */
function noisy(entries: string[]): string | null {
  return entries.length === 0 ? null : `console said: ${entries.join(" | ")}`;
}

// --- the fixture ------------------------------------------------------------

/**
 * An instant whose UTC day and whose Pacific day are never the same.
 *
 * The seed's own timed due date is `now + 72h` (D-130), which inherits the hour
 * the seed ran at — so whether UTC and Pacific disagree about its day depends
 * on what time of day somebody last ran `db:seed`, and a zone assertion that is
 * true every afternoon and false every morning is worse than no assertion. This
 * pins the time of day instead: 05:30 UTC is 21:30 or 22:30 the *previous*
 * day in Pacific, in either half of the year.
 *
 * Three days out keeps the seed's meaning intact — ENG-421 is the timed row
 * that is *ahead* of the clock, against ENG-419 which is behind it, and
 * `isOverdue` branches on exactly that. The clock is Postgres's rather than
 * this machine's, because the two drift (CLAUDE.md).
 */
const { now } = await one(`SELECT now() AS now`);
const straddle = new Date(now);
straddle.setUTCDate(straddle.getUTCDate() + 3);
straddle.setUTCHours(5, 30, 0, 0);

const timed = await one(
  `UPDATE tasks SET due_at = $1, due_has_time = true WHERE key = 'ENG-421' RETURNING key, due_at`,
  [straddle],
);
if (!timed) {
  console.log("\n  FAIL  the seed's timed task ENG-421 is missing — run npm run db:seed\n");
  process.exit(1);
}

const dueIso = new Date(timed.due_at).toISOString();
const SERVER_DAY = label(dueIso, "UTC", "weekday");
const VIEWER_DAY = label(dueIso, VIEWER_ZONE, "weekday");
const SERVER_DAY_MONTH = label(dueIso, "UTC", "month");
const VIEWER_DAY_MONTH = label(dueIso, VIEWER_ZONE, "month");

// --- the browser ------------------------------------------------------------

console.log(`\nbrowser → ${BASE}, viewer in ${VIEWER_ZONE}\n`);

let browser: Browser;
try {
  browser = await chromium.launch(
    process.env.ARBOR_CHROME
      ? { executablePath: process.env.ARBOR_CHROME, headless: true }
      : { channel: "chrome", headless: true },
  );
} catch (e) {
  console.log(
    `\n  Could not start a browser: ${(e as Error).message}\n\n` +
      `  This gate drives the Google Chrome already installed on the machine —\n` +
      `  playwright-core ships no browser of its own, on purpose (D-144).\n` +
      `  Install Chrome, or point at any Chromium-family binary:\n\n` +
      `      ARBOR_CHROME=/path/to/chrome npm run check:browser -- ${PORT}\n`,
  );
  process.exit(1);
}

const sessions = {
  avery: (await signIn("avery@example.com", PASSWORD)).token,
  quinn: (await signIn("quinn@example.com", PASSWORD)).token,
  sam: (await signIn("sam@example.com", PASSWORD)).token,
};

/**
 * A context per identity, which is the point of the whole file.
 *
 * Every gate in this repo drives exactly one person, and all three of the
 * workspace bugs lived in the *difference* between two viewers — a fix for
 * Quinn that breaks Avery passes a single-identity suite perfectly.
 */
async function asViewer(token: string | null): Promise<{
  context: BrowserContext;
  issues: string[];
}> {
  const context = await browser.newContext({ timezoneId: VIEWER_ZONE });
  // Shorter than Playwright's 30s default. Nothing here is slow once the route
  // is compiled, and `warmUp` has compiled all of them — so a locator that is
  // still waiting at ten seconds is not slow, it is absent, and on a red run
  // there may be several of them.
  context.setDefaultTimeout(10_000);
  if (token) {
    await context.addCookies([
      { name: "arbor_session", value: token, url: BASE, httpOnly: true, sameSite: "Lax" },
    ]);
  }
  const issues: string[] = [];
  context.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") issues.push(`${m.type()} ${m.text()}`);
  });
  context.on("weberror", (e) => issues.push(`pageerror ${e.error().message}`));
  return { context, issues };
}

/**
 * Request every route once, and throw away what it said.
 *
 * `next dev` compiles a route on first request, and a chunk asked for while
 * that is still happening comes back 404 — the `?_rsc=` trap CLAUDE.md
 * records, which from inside a browser reads as a missing asset rather than as
 * a server still building. It cost this gate its first red run: nine zone
 * assertions passed and `nothing in the console` failed on
 * `Failed to load resource: 404`, which was Next compiling `/board`.
 *
 * So the console assertions all run against a warm server, and a 404 on a warm
 * server is a real one. Signed in as Sam, because an anonymous request to any
 * of these redirects to `/login` and compiles nothing.
 */
async function warmUp(): Promise<void> {
  const { context } = await asViewer(sessions.sam);
  const page = await context.newPage();
  for (const path of ["/", "/board", "/table"]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  }
  await context.close();

  const anon = await browser.newContext();
  const loginPage = await anon.newPage();
  await loginPage.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await anon.close();
}

await warmUp();

// --- 1. the zone the server is not in ---------------------------------------

console.log("zones and hydration — the half no HTTP assertion can see");

await section("zones and hydration", async () => {
  const cookie = `arbor_session=${sessions.sam}`;
  const { context, issues } = await asViewer(sessions.sam);
  const page = await context.newPage();

  for (const [screen, path, format] of [
    ["list", "/", "weekday"],
    ["board", "/board", "weekday"],
    ["table", "/table", "month"],
  ] as const) {
    const serverDay = format === "weekday" ? SERVER_DAY : SERVER_DAY_MONTH;
    const viewerDay = format === "weekday" ? VIEWER_DAY : VIEWER_DAY_MONTH;

    // The server's own markup, taken over the wire rather than from the
    // browser: by the time Playwright can read the DOM, React has hydrated it.
    const html = await serverHtml(path, cookie);
    report(
      `${screen}: the server pins ENG-421's instant to UTC and says so (${serverDay} UTC)`,
      words(html).includes(`${serverDay} UTC`)
        ? null
        : `no "${serverDay} UTC" in the server's HTML — an instant formatted in the ambient zone is D-121`,
    );

    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    const cell = page
      .locator(screen === "board" ? ".card" : screen === "table" ? "tr" : ".row")
      .filter({ has: page.locator('a.task-link[href="/t/ENG-421"]') })
      .locator(".date")
      .first();
    const hydrated = (await textOf(cell)).trim();

    report(
      `${screen}: the browser re-reads it in the viewer's own zone (${viewerDay}, no marker)`,
      hydrated === viewerDay
        ? null
        : `the hydrated cell reads "${hydrated}", expected "${viewerDay}" — ` +
          `a marker left behind means it never hydrated, the server's day means it ignored the zone`,
    );

    // The control. A calendar day is midnight UTC and read in UTC on both
    // sides (D-067), so it is the row that must *not* move — without it, a
    // renderer that formatted everything in the viewer's zone would pass the
    // two checks above.
    const calendar = page
      .locator(screen === "board" ? ".card" : screen === "table" ? "tr" : ".row")
      .filter({ has: page.locator('a.task-link[href="/t/ENG-380"]') })
      .locator(".date")
      .first();
    const calendarText = (await textOf(calendar)).trim();
    report(
      `${screen}: a calendar day is the control and does not move`,
      words(html).includes(calendarText) && !calendarText.includes("UTC")
        ? null
        : `the calendar-day cell reads "${calendarText}", which is not what the server sent`,
    );
  }

  report("nothing in the console across all three renderers", noisy(issues));
  await context.close();
});

// --- 2. which workspace a screen infers -------------------------------------

console.log("\nwho you are decides which workspace — the thing only a screen infers");

await section("Quinn in Meridian", async () => {
  const { context, issues } = await asViewer(sessions.quinn);
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const text = await textOf(page.locator("body"));

  report(
    "Quinn, a member of Meridian and nothing else, lands in Meridian",
    text.includes("Meridian")
      ? null
      : "Meridian is not named anywhere on Quinn's first screen — resolution by slug is D-137",
  );
  report(
    "…on Meridian's own list, with Meridian's own task",
    text.includes("Dispatch board") && text.includes("OPS-1")
      ? null
      : `expected Dispatch board and OPS-1; the page reads: ${text.slice(0, 200)}`,
  );
  report(
    "…drawn with Meridian's own status set",
    ["Queued", "Dispatched", "Closed out"].every((s) => text.includes(s))
      ? null
      : "Meridian's statuses are not on the page — a status set resolved in the wrong workspace",
  );

  // The absence half, which is the lesson of the phantom sidebar row: every
  // assertion above asks whether the right thing is present, and the row that
  // read `Backlog` was wrong precisely by being an extra.
  const sidebar = await textOf(page.locator("aside.sidebar"));
  report(
    "Quinn's sidebar names nothing that is not Meridian's",
    sidebar.includes("Backlog")
      ? `the sidebar says "Backlog", which is a Northwind container and does not exist in Meridian — ` +
        `that was a hard-coded <a> in the shell's JSX`
      : null,
  );
  report(
    "…and no Northwind task has leaked onto the screen",
    /\bENG-\d+/.test(text) ? `a Northwind key is on Quinn's page: ${/\bENG-\d+/.exec(text)?.[0]}` : null,
  );
  report(
    "…with a workspace name rather than a switcher, being in one workspace",
    (await page.locator("select.ws-switch").count()) === 0
      ? null
      : "a select holding one option is a control that cannot do anything",
  );
  report("nothing in the console on Meridian", noisy(issues));
  await context.close();
});

await section("Avery in Northwind", async () => {
  // The control, and the whole reason this is two identities: "fixed it for
  // Quinn" and "broke it for everybody" look identical from inside Meridian.
  const { context, issues } = await asViewer(sessions.avery);
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const text = await textOf(page.locator("body"));

  report(
    "Avery is the control and still lands in Northwind",
    text.includes("Northwind") && !text.includes("Dispatch board")
      ? null
      : "Avery's screen is not Northwind's — the resolver moved everybody, not just Quinn",
  );
  report(
    "…on Northwind's own list",
    text.includes("Sprint 24")
      ? null
      : `expected Sprint 24 on Avery's screen; it reads: ${text.slice(0, 200)}`,
  );
  report(
    "…with no Meridian task on it",
    text.includes("OPS-1") ? "OPS-1 is on Avery's page — a read that crossed the workspace" : null,
  );
  report("nothing in the console on Northwind", noisy(issues));
  await context.close();
});

// --- 3. the switcher, for the person who has a choice ------------------------

console.log("\nthe switcher — the only control a person in two workspaces has");

await section("the workspace switcher", async () => {
  const { context, issues } = await asViewer(sessions.sam);
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

  const switcher = page.locator("select.ws-switch");
  report(
    "Sam, who is in both, gets a switcher",
    (await switcher.count()) === 1 ? null : "no switcher for somebody with a choice to make",
  );

  // The selected *option*, not the presence of the word: once the switcher
  // shipped, Sam's page legitimately contains "Meridian" in the markup of the
  // option they are not on, and an assertion on the string passed either way.
  const before = await textOf(switcher.locator("option:checked"));
  report(
    "…showing the workspace they are actually in",
    before.trim().length > 0 ? null : "no option is selected",
  );

  const other = (await switcher.locator("option").allInnerTexts()).find(
    (o) => o.trim() !== before.trim(),
  );
  const meridian = await one(`SELECT id FROM workspaces WHERE slug = 'meridian'`);
  await switcher.selectOption(meridian.id);
  // Allowed to expire for the same reason as the dev switcher's wait below: a
  // switch that does nothing is the defect, not an infrastructure timeout.
  await page
    .waitForFunction(
      (was) =>
        (document.querySelector("select.ws-switch option:checked") as HTMLElement | null)
          ?.innerText !== was,
      before,
      { timeout: 20_000 },
    )
    .catch(() => {});

  const after = await textOf(page.locator("body"));
  report(
    `…and choosing the other one (${other?.trim()}) moves the screen to it`,
    after.includes("Dispatch board") && after.includes("OPS-1")
      ? null
      : "the switch did not change what the page is showing",
  );

  // The reload is the check, not a formality: a workspace chosen in memory and
  // a workspace chosen in a validated cookie look the same until you reload.
  await page.reload({ waitUntil: "networkidle" });
  const reloaded = await textOf(page.locator("body"));
  report(
    "…and the choice survives a reload",
    reloaded.includes("Dispatch board")
      ? null
      : "the reload went back to the other workspace — the choice was never written",
  );
  report("nothing in the console across the switch", noisy(issues));
  await context.close();
});

// --- 4. the dev switcher, which has to end a session to work -----------------

console.log("\nthe dev switcher — inert under a real session until D-138");

await section("the dev switcher", async () => {
  const { context, issues } = await asViewer(sessions.avery);
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

  const switcher = page.locator("label.switcher select");
  if ((await switcher.count()) === 0) {
    skip(
      "becoming somebody else actually becomes them",
      "no dev switcher on this server — it renders only when devAuthEnabled(), so this is a production build",
    );
  } else {
    const quinn = await one(`SELECT id, name FROM users WHERE email = 'quinn@example.com'`);
    await switcher.selectOption(quinn.id);

    // Meridian is the assertion, not Quinn's name. The switcher is *rendered*
    // either way and the select's own value changes either way — what was
    // broken was that it silently changed nothing, because `getCurrentUser()`
    // returns the session user first and the session was still Avery's. The
    // workspace moving is the only proof the identity did: Quinn is in
    // Meridian and Avery is not (D-137, D-138).
    // The wait is allowed to expire, and `.catch` is the point rather than
    // sloppiness: *not moving* is exactly the failure this check exists to
    // describe, and a `waitForFunction: Timeout 30000ms exceeded` says that far
    // less clearly than the assertion below does. Verified by reverting D-138,
    // where this read as a timeout until it was allowed to fall through.
    await page
      .waitForFunction(() => document.body.innerText.includes("Dispatch board"), undefined, {
        timeout: 20_000,
      })
      .catch(() => {});
    const text = await textOf(page.locator("body"));
    report(
      "becoming Quinn ends Avery's session and lands on Meridian",
      text.includes("OPS-1") && !text.includes("Sprint 24")
        ? null
        : "the switcher changed its own value and nothing else — that is the D-138 shape exactly",
    );
    report("nothing in the console across the switch", noisy(issues));
  }
  await context.close();
});

// --- 5. a person with a password --------------------------------------------

console.log("\nsigning in — the door everybody else in this file walked past");

await section("signing in", async () => {
  // Every check above injects a session cookie, which is fast and is also a
  // way of never testing the login screen. Quinn signs in the way a person
  // does, and lands where D-137 says they should.
  const { context, issues } = await asViewer(null);
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });

  await page.locator('input[type="email"]').fill("quinn@example.com");
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator("button.login-submit").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });

  const text = await textOf(page.locator("body"));
  report(
    "Quinn signs in with a password and lands in Meridian",
    text.includes("Dispatch board") && text.includes("OPS-1")
      ? null
      : `signed in but landed somewhere else: ${text.slice(0, 200)}`,
  );
  report("nothing in the console on the way in", noisy(issues));
  await context.close();
});

await browser.close();
await db.end();

console.log(
  failures === 0
    ? `\nall browser checks passed against ${BASE}\n`
    : `\n${failures} browser check${failures === 1 ? "" : "s"} failed against ${BASE}\n`,
);
process.exit(failures === 0 ? 0 : 1);
