-- A task's description, as a portable block document.
--
-- `description_doc_id` has been on this table since 0000 and points at a Yjs
-- document that Phase 9 will create. That is the collaborative *editing* of a
-- description; this is the description. Storing it in the same format comments
-- use means Phase 9 migrates one shape rather than two, and the mention nodes
-- work in both without a second parser.
ALTER TABLE "tasks" ADD COLUMN "description" jsonb;
