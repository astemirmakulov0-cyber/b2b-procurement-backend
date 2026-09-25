-- Per-company email notification preferences. In-app notifications (Notification table) are unaffected;
-- these only gate whether notify() also sends an email.
ALTER TABLE "Company" ADD COLUMN "emailNewRfq" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Company" ADD COLUMN "emailOtherNotifications" BOOLEAN NOT NULL DEFAULT true;
