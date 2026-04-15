-- Remove price and cyclic fields from venture_templates (not needed for ventures)
ALTER TABLE venture_templates DROP COLUMN IF EXISTS price_wei;
ALTER TABLE venture_templates DROP COLUMN IF EXISTS price_usd;
ALTER TABLE venture_templates DROP COLUMN IF EXISTS default_cyclic;
