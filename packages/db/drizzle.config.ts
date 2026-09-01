import { defineConfig } from "drizzle-kit";

import { loadRootEnv } from "./src/env";

loadRootEnv();

const url = process.env.DATABASE_URL;

// No hardcoded fallback. A silent default to localhost is how a migration gets
// run against the wrong database — it succeeds locally and does nothing in
// production, with no error to notice.
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Run `cp .env.example .env` at the repository root.",
  );
}

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
