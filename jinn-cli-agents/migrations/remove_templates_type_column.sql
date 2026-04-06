-- Remove venture-type rows (now in venture_templates)
DELETE FROM templates WHERE type = 'venture';

-- Drop the type column and its index
DROP INDEX IF EXISTS idx_templates_type;
ALTER TABLE templates DROP COLUMN IF EXISTS type;
