-- Stage 5: optional RFQ specifications for suppliers (up to 2000 characters).
-- A new nullable column: the code already running in production ignores it.
ALTER TABLE "RFQ" ADD COLUMN "specifications" TEXT;
ALTER TABLE "RFQ" ADD CONSTRAINT "RFQ_specifications_check" CHECK ("specifications" IS NULL OR char_length("specifications") <= 2000);
