-- What a document points at (D-120). An edge table maintained on write, the
-- same bet `search_text` makes: answering "what links here" from the documents
-- themselves would mean loading and parsing every CRDT in the workspace to
-- render one footer.
--
-- The last two statements carry IF NOT EXISTS because 0011 created those
-- indexes by hand and the drizzle snapshot never recorded them, so every
-- generate re-proposes them. Without the guard this file fails on any database
-- that has run 0011 — which is all of them.

CREATE TYPE "public"."doc_link_target" AS ENUM('page', 'task');--> statement-breakpoint
CREATE TABLE "doc_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_doc_id" uuid NOT NULL,
	"target_kind" "doc_link_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_links" ADD CONSTRAINT "doc_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_links" ADD CONSTRAINT "doc_links_source_doc_id_docs_id_fk" FOREIGN KEY ("source_doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "doc_links_unique" ON "doc_links" USING btree ("source_doc_id","target_kind","target_id");--> statement-breakpoint
CREATE INDEX "doc_links_target_idx" ON "doc_links" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "docs_search_text_trgm_idx" ON "docs" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "docs_title_trgm_idx" ON "docs" USING gin ("title" gin_trgm_ops);