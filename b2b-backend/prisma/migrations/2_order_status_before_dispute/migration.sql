-- L9: dispute resolution by an admin.
-- Both changes are metadata-only (no table rewrite, no data touched), and the code already running in
-- production keeps working while the migration is applied: it ignores the new column and never writes
-- a message without a sender.

-- The order status at the moment a dispute is opened, so an admin can resume the order there.
ALTER TABLE "Order" ADD COLUMN "statusBeforeDispute" "OrderStatus";

-- Admin comments in the order chat: admins have no company, so their messages have no sender company.
-- The foreign key stays; NULL means "platform admin".
ALTER TABLE "Message" ALTER COLUMN "senderCompanyId" DROP NOT NULL;
