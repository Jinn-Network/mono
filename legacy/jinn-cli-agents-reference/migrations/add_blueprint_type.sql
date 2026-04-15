-- Add type field to templates table to distinguish venture vs agent blueprints
ALTER TABLE templates ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'agent' CHECK (type IN ('venture', 'agent'));

-- Create index for filtering
CREATE INDEX IF NOT EXISTS idx_templates_type ON templates(type);

-- Update existing blueprints based on their nature
-- Ventures: orchestrators, foundries, meta-templates
UPDATE templates SET type = 'venture' WHERE slug IN (
  'blog-growth-orchestrator',
  'code-health-venture',
  'marketing-content-venture',
  'x402-service-optimizer'
);

-- Everything else is agent type (already default)
