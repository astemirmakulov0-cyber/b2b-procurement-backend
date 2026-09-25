-- The supplier enters a price per unit; the quote total (price) = unitPrice x the RFQ quantity.
-- Existing quotes keep unitPrice NULL: their price was entered, and is used, as the total.
-- A new nullable column: the code already running in production ignores it.
ALTER TABLE "Quote" ADD COLUMN "unitPrice" DECIMAL(12,3);
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_unitPrice_check" CHECK ("unitPrice" IS NULL OR "unitPrice" > 0);
