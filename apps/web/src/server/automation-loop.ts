import "server-only";

import { drainAutomations } from "@arbor/db";

/**
 * The automation drain, running inside the server process (D-125).
 *
 * **Started from the server's own module graph rather than from
 * `instrumentation.ts`**, and that was not the first choice. The hook is the
 * textbook place for this and it does not work here: `register` is compiled for
 * every runtime including the edge one, and that compilation follows the import
 * into `@arbor/db` — then into `pg`, then into `fs` and `path`, which the edge
 * bundle has no answer for. Next's documented remedy is a conditional import of
 * a relative node-only file, and it was tried and the trace followed that too,
 * because `transpilePackages` means the workspace packages are compiled into
 * whatever bundle references them. The failure is worth describing because it
 * does not look like bundling: every page 500s with "Can't resolve 'path'",
 * which reads exactly like the database being unreachable.
 *
 * So the loop starts from code that is *already* in the node server graph and
 * already imports this package successfully. Nothing had to be configured, and
 * there is no bundler special case to remember.
 *
 * **Both replicas run it, and that is fine.** `desired_count = 2`, and
 * `claimDueRuns` takes work with `FOR UPDATE SKIP LOCKED` — so two drains are
 * two workers on one queue rather than two copies of every run. That property
 * was built before this file existed and is what makes this file short.
 *
 * **Nothing here is configurable**, deliberately: a tick interval in the
 * environment would be a fourth variable every deployment has to supply
 * (invariant 14) to tune something nobody has yet needed to tune.
 */

/** How long between drains. Not an environment variable, on purpose. */
const EVERY_MS = 5_000;

/** Backoff after a failure, so an unreachable database is not hammered. */
const AFTER_FAILURE_MS = 30_000;

let started = false;
let stopping = false;

/**
 * Not re-entrant: a drain that outlives the interval must not have a second one
 * started on top of it, or two ticks in one process race for the same rows and
 * only `SKIP LOCKED` stands between that and doubled work.
 */
let running = false;

async function tick(): Promise<number> {
  if (running || stopping) return EVERY_MS;
  running = true;
  try {
    await drainAutomations();
    return EVERY_MS;
  } catch (error) {
    // Never throw out of here. An unhandled rejection in a timer takes the
    // server down, and an engine that cannot reach Postgres is a reason to
    // retry, not a reason to stop serving pages.
    console.error("[automations] drain failed:", error);
    return AFTER_FAILURE_MS;
  } finally {
    running = false;
  }
}

// setTimeout rather than setInterval, so the delay is measured from the *end* of
// a drain. An interval firing faster than the work takes queues its callbacks up
// behind each other and turns one slow tick into a backlog.
function schedule(delay: number): void {
  const timer = setTimeout(() => void tick().then(schedule), delay);
  // The loop must not be what keeps node alive: a process with nothing left to
  // serve should still be allowed to exit.
  timer.unref?.();
}

/**
 * Starts the drain once per process.
 *
 * Idempotent and cheap, because it is called from more than one place on
 * purpose — see the callers. In development Next can hold more than one module
 * instance across recompiles, so "once" is a best effort rather than a
 * guarantee; two loops would still be two workers on one queue, which is the
 * same thing two replicas already are.
 */
export function ensureAutomationLoop(): void {
  if (started) return;
  started = true;

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      stopping = true;
    });
  }

  schedule(EVERY_MS);
}
