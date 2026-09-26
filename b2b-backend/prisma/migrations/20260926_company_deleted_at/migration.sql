-- PDPL self-service account erasure: marks when a company anonymized itself (Settings > Delete account).
-- name/registrationNumber/country are kept; phone/address/verificationNotes are cleared at the same time.
ALTER TABLE "Company" ADD COLUMN "deletedAt" TIMESTAMP(3);
