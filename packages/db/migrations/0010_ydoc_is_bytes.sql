ALTER TABLE "docs" ALTER COLUMN "ydoc" TYPE bytea USING convert_to("ydoc", 'UTF8');
