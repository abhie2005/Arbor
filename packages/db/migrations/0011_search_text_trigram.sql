-- Search reads `docs.search_text`, and `ILIKE '%term%'` cannot use a btree
-- index: a leading wildcard means no prefix to descend on, so the plan is a
-- sequential scan over every page in the workspace. Trigram GIN is the index
-- that does answer an unanchored pattern, which is what makes the ILIKE
-- decision (D-113) affordable rather than merely simple.
--
-- `IF NOT EXISTS` on the extension because self-hosters may already have it,
-- and because this file has to be safe to run twice. It needs a role that may
-- create an extension — the superuser in the compose stack, `rds_superuser` on
-- RDS. No managed vendor is in the path (that is a project rule), so there is
-- no host here that forbids it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "docs_search_text_trgm_idx" ON "docs" USING gin ("search_text" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "docs_title_trgm_idx" ON "docs" USING gin ("title" gin_trgm_ops);

-- Deliberately no index on `tasks.name`, though the compiler matches it the
-- same way. The task query joins `access_index` first and that join is the most
-- selective predicate in it by design (compiler rule 1), so the name test runs
-- as a filter over rows the viewer can already reach rather than as a scan of
-- the table. An index the planner has no reason to choose is a write cost on
-- every task edit for nothing. When a workspace is large enough for that to be
-- wrong, the evidence will be a plan, and the fix is this file again.
