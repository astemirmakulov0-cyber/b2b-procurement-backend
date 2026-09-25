-- L4 (stage 1): documents attached to an order (delivery notes, invoices, other files).
-- The files live in the private storage bucket; this table holds their metadata. A new table only:
-- nothing existing is changed, and the code already running in production doesn't know about it.
CREATE TABLE "OrderDocument" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedByCompanyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "OrderDocument_pkey" PRIMARY KEY ("id"),
    -- text + CHECK instead of an enum (as for Quote.currency): a new kind is a constraint change,
    -- and an older Prisma client never meets an enum value it doesn't know
    CONSTRAINT "OrderDocument_kind_check" CHECK ("kind" IN ('DELIVERY_NOTE', 'INVOICE', 'OTHER')),
    CONSTRAINT "OrderDocument_sizeBytes_check" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 10485760)
);

CREATE UNIQUE INDEX "OrderDocument_storageKey_key" ON "OrderDocument"("storageKey");
CREATE INDEX "OrderDocument_orderId_createdAt_idx" ON "OrderDocument"("orderId", "createdAt");

ALTER TABLE "OrderDocument" ADD CONSTRAINT "OrderDocument_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderDocument" ADD CONSTRAINT "OrderDocument_uploadedByCompanyId_fkey" FOREIGN KEY ("uploadedByCompanyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
