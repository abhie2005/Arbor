-- Phase 10. What the automations table needed to actually run (D-125, D-126).
--
-- Hand-written rather than generated, like 0011: `generate` has no way to know
-- that a pending run and a finished one are the same row, and the partial index
-- below is the whole reason the claim is cheap.

-- A service account is a real user, so it is a principal in access_index like
-- anybody else and `applyOperations` can name it as an actor (D-126). A column
-- rather than a table: everything that makes a user a user is still true.
ALTER TABLE users ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'person';

-- A pending run is an execution that has not happened yet, which is why this is
-- the queue rather than a table beside it: the run record and the claim are one
-- row, and the unique index already on idempotency_key is what makes an
-- overlapping scan harmless.
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS run_after timestamptz NOT NULL DEFAULT now();
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

-- Partial, because the queue is the small live tail of a table that only grows.
-- Without `WHERE status = 'pending'` the claim scans every run ever recorded.
CREATE INDEX IF NOT EXISTS automation_runs_due_idx
  ON automation_runs (run_after)
  WHERE status = 'pending';

-- Which run produced an activity row, so a cascade can count its own depth.
-- `automation_id` beside it has been in the schema since Phase 1 and unwritten
-- since Phase 1; it is populated now, and it is what the history reads to say
-- a rule did this rather than a person.
ALTER TABLE activity ADD COLUMN IF NOT EXISTS automation_run_id uuid
  REFERENCES automation_runs(id) ON DELETE SET NULL;

-- Where the scan got to. Per workspace, so one busy workspace cannot hold up
-- another, and `last_activity_id` rather than a timestamp because the sequence
-- is what the overlap is expressed in.
CREATE TABLE IF NOT EXISTS automation_cursors (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  last_activity_id bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
