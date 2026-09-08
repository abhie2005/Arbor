-- `notifications.activity_id` could never hold an activity id.
--
-- It was declared `uuid` in 0000 while `activity.id` is a `bigserial`, and it
-- carries no foreign key, so nothing ever rejected the impossible value. The
-- mismatch survived four migrations because nothing had written to this table
-- yet — the notification fan-out is the first code to go looking for it.
--
-- Dropped and re-added rather than altered: Postgres has no uuid-to-bigint
-- cast, so `SET DATA TYPE` fails outright. That is safe here precisely because
-- the column has never held anything; if it ever had, this would need a
-- backfill instead and would not be a one-line migration.
ALTER TABLE "notifications" DROP COLUMN "activity_id";
ALTER TABLE "notifications" ADD COLUMN "activity_id" bigint;
