-- Remove redundant whitelisted columns from operators table.
-- The tier_override column is the sole mechanism for setting trust tiers.
--
-- Run after all previous migrations:
--   psql $ACL_DATABASE_URL -f migrations/008_remove_whitelisted_columns.sql

-- Step 1: Migrate existing whitelisted operators to tier_override
-- so they don't lose their trusted status when columns are dropped.
UPDATE operators
SET tier_override = 'trusted'
WHERE whitelisted = true
  AND (tier_override IS NULL OR tier_override = 'untrusted');

-- Step 2: Drop the redundant columns
ALTER TABLE operators DROP COLUMN IF EXISTS whitelisted;
ALTER TABLE operators DROP COLUMN IF EXISTS whitelisted_by;
ALTER TABLE operators DROP COLUMN IF EXISTS whitelisted_at;
