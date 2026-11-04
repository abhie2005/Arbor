-- A form is a door into one list that does not need a session (D-142).
--
-- It is the third answer to the same question D-126 and D-133 answered, with
-- "and anonymously" added to it: a public submission acts as a **service
-- account of its own** — a `users` row with `kind = 'service'`, a `guest`
-- membership and a grant on the form's container — so the permission model
-- learns no new principal kind and the activity log can say which form wrote a
-- task. `guest` for the reason D-133 gives: `member` would inherit a baseline
-- of `edit` on every container nobody marked private, so a form "on one list"
-- would quietly reach the workspace.
--
-- `fields` is the declaration of what the form *asks*, and it is also what
-- bounds a submission: a public writer may fill the fields a manager declared
-- and nothing else. Without that, a form is an unauthenticated write to any
-- column, which is the obvious way this feature goes wrong.
--
-- There is deliberately **no submissions table**. A submission creates a task
-- through `applyOperations` like every other write (invariant 1), so the task
-- *is* the record, with the activity row and the inverse that come with it. A
-- second table would be a second source of truth about the same event, and the
-- first question anybody asks of it — "what came in from this form?" — is a
-- filter on tasks, not a different table.
--
-- `submission_count` is a counter rather than a COUNT(*) of anything, because
-- it is the quota's number: a closed form stops accepting and the count has to
-- survive the tasks being archived or deleted.
--
-- Hand-written. `drizzle-kit generate` dies on this machine with "Do not know
-- how to serialize a BigInt" before it writes anything, with or without this
-- table (CLAUDE.md, D-133).
CREATE TABLE IF NOT EXISTS forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  container_id uuid NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- What somebody filling it in reads above the fields. Plain text: a form's
  -- own prose is not a document, and a block tree here would mean a second
  -- editor for one paragraph.
  intro text,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_open boolean NOT NULL DEFAULT true,
  submission_count integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS forms_container_idx ON forms (container_id);
CREATE INDEX IF NOT EXISTS forms_workspace_idx ON forms (workspace_id);
CREATE INDEX IF NOT EXISTS forms_principal_idx ON forms (principal_id);
