-- Stage 4: the one active RFQ category is named like on the landing page. Data only, no schema change.
-- The server also maps the old name to the new one (pages loaded before the rename still send it).
UPDATE "RFQ" SET "category" = 'Restaurants & Cafés' WHERE "category" = 'Restaurant Groceries';
