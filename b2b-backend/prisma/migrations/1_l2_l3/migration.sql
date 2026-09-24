-- L2: Quote.currency is BHD only (for now).
-- A CHECK constraint instead of an enum: the column stays text, so the code already running in
-- production keeps working while the migration is applied (an enum column breaks the deployed Prisma
-- client until new code is out). Validates existing rows: fails if any quote isn't BHD.
-- To allow another currency later, replace the constraint in a new migration.
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_currency_bhd_check" CHECK ("currency" = 'BHD');

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
