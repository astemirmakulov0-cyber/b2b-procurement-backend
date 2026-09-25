-- Stage 6: keep the supplier's reason for declining an LPO, so the buyer sees it next to the quote.
-- A new nullable column: the code already running in production ignores it.
ALTER TABLE "LPO" ADD COLUMN "declineReason" TEXT;
ALTER TABLE "LPO" ADD CONSTRAINT "LPO_declineReason_check" CHECK ("declineReason" IS NULL OR char_length("declineReason") <= 500);
