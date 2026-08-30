import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

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
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env, or run `npm run docker:up` to start Postgres locally.",
    );
  }

  return new Pool({
    connectionString,
    max: options.max ?? 10,
    ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
  });
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
