-- A token that is not a session (D-133).
--
-- It acts as a *named service account per integration* rather than as a
-- workspace-wide robot or as the person who minted it: a `users` row with
-- `kind = 'service'` holding its own membership and its own grants, which is
-- D-126's answer applied to the API's half of the question. Nothing in the
-- permission model learns a new principal kind, because there isn't one.
--
-- Hashed like a session's token, and shown exactly once. `prefix` is the
-- readable head so a list can name a token without holding it.
--
-- `container_id` is the container the token was minted against, which is not
-- where its permissions live — those are `grants`, and the sharing screen may
-- change them afterwards. It is the scope it was created with, so a settings
-- list can say "edit on Engineering" and a revocation has a container to be a
-- sentence about (`ConfigEvent`'s object kinds do not include a workspace).
--
-- Hand-written. `drizzle-kit generate` dies on this machine with "Do not know
-- how to serialize a BigInt" before it writes anything — with or without this
-- table, so it is the tool and not the schema (see CLAUDE.md). The same was
-- true of 0011's trigram indexes for a different reason.
CREATE TABLE IF NOT EXISTS api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  container_id uuid NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  prefix text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  last_used_at timestamp with time zone,
  expires_at timestamp with time zone,
  revoked_at timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_token_key ON api_tokens (token_hash);
CREATE INDEX IF NOT EXISTS api_tokens_workspace_idx ON api_tokens (workspace_id);
CREATE INDEX IF NOT EXISTS api_tokens_principal_idx ON api_tokens (principal_id);
