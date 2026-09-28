ALTER TABLE "access_index" RENAME COLUMN "list_id" TO "container_id";--> statement-breakpoint
ALTER TABLE "access_index" RENAME CONSTRAINT "access_index_principal_id_list_id_pk" TO "access_index_principal_id_container_id_pk";--> statement-breakpoint
ALTER TABLE "access_index" RENAME CONSTRAINT "access_index_list_id_containers_id_fk" TO "access_index_container_id_containers_id_fk";--> statement-breakpoint
ALTER INDEX "access_index_list_idx" RENAME TO "access_index_container_idx";
