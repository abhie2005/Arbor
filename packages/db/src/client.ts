import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { envSearchOrigin, loadRootEnv } from "./env";
import * as schema from "./schema";

// Any process that touches the database gets the root .env, wherever it was
// started from. Import order matters: this must run before the first read of
// process.env.DATABASE_URL below.
loadRootEnv();

export type Database = ReturnType<typeof createDatabase>;

export interface DatabaseOptions {
  connectionString?: string;
  /** Fargate tasks are long-lived, so a real pool is worth having. */
  max?: number;
  ssl?: boolean;
}

/**
 * A plain node-postgres pool — no vendor driver.
 *
 * The same code path serves the local Docker container, RDS, and Cloud SQL;
 * only the connection string changes.
 */
export function createPool(options: DatabaseOptions = {}): Pool {
  return new Pool({
    connectionString: connectionString(options),
    max: options.max ?? 10,
    ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
  });
}

/**
 * Where the database is, and the one error message that says so.
 *
 * Exported because the pool is not the only thing that connects: a `LISTEN`
 * holds a connection open forever and must not take one from the pool
 * (`live.ts`), and a second copy of this lookup would be a second place for the
 * error to be less helpful than this one.
 */
export function connectionString(options: DatabaseOptions = {}): string {
  const value = options.connectionString ?? process.env.DATABASE_URL;

  if (!value) {
    throw new Error(
      `DATABASE_URL is not set, and no .env file was found searching upward from ${envSearchOrigin()}. ` +
        "Run `cp .env.example .env` at the repository root.",
    );
  }

  return value;
}

export function createDatabase(options: DatabaseOptions = {}) {
  return drizzle(createPool(options), { schema });
}

let cachedDb: Database | undefined;
let cachedPool: Pool | undefined;

/** Process-wide singleton, so hot reload doesn't exhaust connections. */
export function db(): Database {
  cachedDb ??= createDatabase();
  return cachedDb;
}

export function pool(): Pool {
  cachedPool ??= createPool();
  return cachedPool;
}

/**
 * Runs a query produced by the view compiler.
 *
 * The compiler emits parameterized SQL text rather than a Drizzle query builder
 * chain, which is what keeps @arbor/core free of any database dependency. This
 * is the seam where that text meets a connection.
 */
export async function executeCompiled<T extends Record<string, unknown>>(
  query: { text: string; params: unknown[] },
  connection: Pool = pool(),
): Promise<T[]> {
  const result = await connection.query(query.text, query.params);
  return result.rows as T[];
}
