-- Buyer's receipt confirmation (acceptance of the goods); invoices become payable from this moment.
-- Nullable, no default: metadata-only (no table rewrite), and the code already running in production
-- ignores the new column while the migration is applied.
ALTER TABLE "Order" ADD COLUMN "receivedAt" TIMESTAMP(3);
