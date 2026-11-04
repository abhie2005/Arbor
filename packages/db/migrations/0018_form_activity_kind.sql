-- A form is a thing the activity log can be about (D-142).
--
-- Its own migration rather than a line in 0017, because `ALTER TYPE ... ADD
-- VALUE` cannot run in the same transaction as something that then uses the
-- new value — the same reason 0014 is separate from 0013.
ALTER TYPE "public"."object_kind" ADD VALUE IF NOT EXISTS 'form';
