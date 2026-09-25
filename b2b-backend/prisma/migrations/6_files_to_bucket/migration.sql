-- L4 (stage 3): catalog photos and verification documents move from data: URLs in the database to the
-- private storage bucket. New columns for the bucket key; the old data: URL columns stay until they are
-- cleared (scripts/migrate-files-to-bucket.js --cleanup, after the move has been verified).
-- Metadata-only changes: the code already running in production keeps working while this is applied.
-- Once data: URLs have been cleared (fileUrl NULL), the code must not be rolled back to a version before this one.

ALTER TABLE "CatalogItem" ADD COLUMN "imageKey" TEXT, ADD COLUMN "imageContentType" TEXT;
CREATE UNIQUE INDEX "CatalogItem_imageKey_key" ON "CatalogItem"("imageKey");

ALTER TABLE "CompanyDocument" ADD COLUMN "storageKey" TEXT, ADD COLUMN "contentType" TEXT, ADD COLUMN "sizeBytes" INTEGER,
    ALTER COLUMN "fileUrl" DROP NOT NULL;
CREATE UNIQUE INDEX "CompanyDocument_storageKey_key" ON "CompanyDocument"("storageKey");
-- a document always has its file: inline (legacy) or in the bucket
ALTER TABLE "CompanyDocument" ADD CONSTRAINT "CompanyDocument_file_check" CHECK ("fileUrl" IS NOT NULL OR "storageKey" IS NOT NULL);
