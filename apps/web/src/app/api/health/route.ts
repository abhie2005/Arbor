import { pool } from "@arbor/db";

/**
 * `/api/health` — what the load balancer asks before sending traffic (D-114).
 *
 * **It checks the database, not just the process.** A Fargate task whose
 * Postgres connection is gone still answers HTTP, and a health check that only
 * proves Node is running would keep that task in the target group and serve
 * errors from it. `SELECT 1` is the cheapest question that distinguishes
 * "listening" from "working".
 *
 * **It says nothing about what is wrong.** The body is `ok` or `unavailable`
 * and the reason goes to the logs. A health endpoint is unauthenticated by
 * necessity — the load balancer has no session — so it is the one route that
 * must not describe the inside of the system to whoever asks.
 *
 * `no-store`, because a cached health check is not a health check.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const headers = { "cache-control": "no-store", "content-type": "text/plain" };

  try {
    await pool().query("SELECT 1");
    return new Response("ok", { status: 200, headers });
  } catch (error) {
    // Logged rather than returned: this is what CloudWatch is for, and the
    // response is read by a load balancer that only branches on the status.
    console.error("[health] database unreachable", error);
    return new Response("unavailable", { status: 503, headers });
  }
}
