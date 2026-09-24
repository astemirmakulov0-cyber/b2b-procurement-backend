-- L2: Quote.currency becomes an enum (BHD only for now).
-- Hand-written instead of Prisma's generated DROP COLUMN + ADD COLUMN: the column is converted in
-- place, keeping every value, and the migration fails if any row holds something that isn't a Currency.
CREATE TYPE "Currency" AS ENUM ('BHD');
ALTER TABLE "Quote" ALTER COLUMN "currency" DROP DEFAULT;
ALTER TABLE "Quote" ALTER COLUMN "currency" TYPE "Currency" USING ("currency"::"Currency");
ALTER TABLE "Quote" ALTER COLUMN "currency" SET DEFAULT 'BHD';

-- L3: indexes on foreign keys and hot queries
CREATE INDEX "CatalogItem_supplierCompanyId_idx" ON "CatalogItem"("supplierCompanyId");
CREATE INDEX "CompanyDocument_companyId_idx" ON "CompanyDocument"("companyId");
CREATE INDEX "LPO_buyerCompanyId_idx" ON "LPO"("buyerCompanyId");
CREATE INDEX "LPO_supplierCompanyId_idx" ON "LPO"("supplierCompanyId");
CREATE INDEX "Message_orderId_createdAt_idx" ON "Message"("orderId", "createdAt");
CREATE INDEX "Notification_companyId_createdAt_idx" ON "Notification"("companyId", "createdAt");
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");
CREATE INDEX "Quote_supplierCompanyId_idx" ON "Quote"("supplierCompanyId");
CREATE INDEX "RFQ_buyerCompanyId_idx" ON "RFQ"("buyerCompanyId");
CREATE INDEX "RFQ_status_createdAt_idx" ON "RFQ"("status", "createdAt");
CREATE INDEX "WalletTransaction_walletId_createdAt_idx" ON "WalletTransaction"("walletId", "createdAt");
