-- "In 3 days, if still open" (D-128).
--
-- The delay belongs to the rule rather than to its trigger: what fires a rule
-- and how long it waits before acting are different questions, and the trigger
-- jsonb is matched against an activity row where a duration has no meaning.
--
-- Seconds rather than an interval, because every caller — a form, the API, a
-- test — has a number and not a Postgres interval literal, and `now() +
-- make_interval(secs => n)` is the one place that has to know the difference.
ALTER TABLE automations ADD COLUMN IF NOT EXISTS delay_seconds integer NOT NULL DEFAULT 0;
