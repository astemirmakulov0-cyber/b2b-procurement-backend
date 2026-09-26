-- Payment terms (days) the supplier sets in its quote, carried to the LPO and the invoice; the invoice's
-- dueDate is only computed once the buyer confirms receipt (see the Invoice.dueDate comment in schema.prisma).
ALTER TABLE "Invoice" ADD COLUMN     "paymentTermsDays" INTEGER DEFAULT 30;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_paymentTermsDays_check" CHECK ("paymentTermsDays" IS NULL OR ("paymentTermsDays" >= 0 AND "paymentTermsDays" <= 120));

ALTER TABLE "LPO" ADD COLUMN     "paymentTermsDays" INTEGER DEFAULT 30;
ALTER TABLE "LPO" ADD CONSTRAINT "LPO_paymentTermsDays_check" CHECK ("paymentTermsDays" IS NULL OR ("paymentTermsDays" >= 0 AND "paymentTermsDays" <= 120));

ALTER TABLE "Quote" ADD COLUMN     "paymentTermsDays" INTEGER DEFAULT 30;
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_paymentTermsDays_check" CHECK ("paymentTermsDays" IS NULL OR ("paymentTermsDays" >= 0 AND "paymentTermsDays" <= 120));
