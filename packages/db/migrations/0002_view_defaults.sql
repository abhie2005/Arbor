-- Hand-edited after generation. drizzle-kit emitted a bare
--   ALTER COLUMN "is_default" SET DATA TYPE boolean
-- which Postgres rejects: there is no assignment cast from text to boolean, so
-- it needs an explicit USING. The generated SET NOT NULL would then have failed
-- too, because the existing rows hold NULL and SET DEFAULT does not backfill.
--
-- The column was never written to — it is text by mistake — so the USING clause
-- below is about satisfying the type system, not about preserving data.
ALTER TABLE "views" ALTER COLUMN "is_default" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "views"
  ALTER COLUMN "is_default" SET DATA TYPE boolean
  USING (COALESCE("is_default", 'false') NOT IN ('false', 'f', '0', ''));--> statement-breakpoint
UPDATE "views" SET "is_default" = false WHERE "is_default" IS NULL;--> statement-breakpoint
ALTER TABLE "views" ALTER COLUMN "is_default" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "views" ALTER COLUMN "is_default" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "task_types_one_default" ON "task_types" USING btree ("workspace_id") WHERE "task_types"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "views_one_default_per_parent" ON "views" USING btree ("parent_id") WHERE "views"."is_default";
