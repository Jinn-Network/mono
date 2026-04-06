-- Migration: Remove unused fields from services table
-- Fields removed: status, primary_language, version, config, tags
-- Rationale: These fields added unnecessary complexity without providing value

-- Drop indexes first
DROP INDEX IF EXISTS idx_services_status;
DROP INDEX IF EXISTS idx_services_tags;
DROP INDEX IF EXISTS idx_services_primary_language;

-- Drop columns
ALTER TABLE services DROP COLUMN IF EXISTS status;
ALTER TABLE services DROP COLUMN IF EXISTS primary_language;
ALTER TABLE services DROP COLUMN IF EXISTS version;
ALTER TABLE services DROP COLUMN IF EXISTS config;
ALTER TABLE services DROP COLUMN IF EXISTS tags;
