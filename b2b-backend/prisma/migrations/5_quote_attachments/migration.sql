-- L4 (stage 2): bid attachments — files a supplier adds to its quote (up to 5, 10 MB each).
-- A new table plus relaxed constraints on OrderDocument: the code already running in production keeps
-- working while this is applied (it doesn't know the table, and nothing it writes becomes invalid).
CREATE TABLE "QuoteAttachment" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "QuoteAttachment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "QuoteAttachment_sizeBytes_check" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 10485760)
);

CREATE UNIQUE INDEX "QuoteAttachment_storageKey_key" ON "QuoteAttachment"("storageKey");
CREATE INDEX "QuoteAttachment_quoteId_createdAt_idx" ON "QuoteAttachment"("quoteId", "createdAt");

ALTER TABLE "QuoteAttachment" ADD CONSTRAINT "QuoteAttachment_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The winning bid's attachments become order documents that point at the same stored object (objects are
-- never overwritten or deleted), so the storage key is no longer unique there; a new document kind for them.
DROP INDEX "OrderDocument_storageKey_key";
CREATE INDEX "OrderDocument_storageKey_idx" ON "OrderDocument"("storageKey");
ALTER TABLE "OrderDocument" DROP CONSTRAINT "OrderDocument_kind_check";
ALTER TABLE "OrderDocument" ADD CONSTRAINT "OrderDocument_kind_check" CHECK ("kind" IN ('DELIVERY_NOTE', 'INVOICE', 'OTHER', 'QUOTE_ATTACHMENT'));
