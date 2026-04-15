-- Add missing columns to venture_templates to match workstream templates
ALTER TABLE venture_templates ADD COLUMN IF NOT EXISTS input_schema JSONB DEFAULT '{}';
ALTER TABLE venture_templates ADD COLUMN IF NOT EXISTS output_spec JSONB DEFAULT '{}';
ALTER TABLE venture_templates ADD COLUMN IF NOT EXISTS price_wei TEXT;
ALTER TABLE venture_templates ADD COLUMN IF NOT EXISTS price_usd TEXT;
ALTER TABLE venture_templates ADD COLUMN IF NOT EXISTS safety_tier TEXT DEFAULT 'public' CHECK (safety_tier IN ('public', 'private', 'restricted'));
ALTER TABLE venture_templates ADD COLUMN IF NOT EXISTS default_cyclic BOOLEAN DEFAULT false;
ALTER TABLE venture_templates ADD COLUMN IF NOT EXISTS olas_agent_id INTEGER;

-- Drop tags from both tables
ALTER TABLE venture_templates DROP COLUMN IF EXISTS tags;
ALTER TABLE templates DROP COLUMN IF EXISTS tags;

-- Add venture_template_id to ventures for "deployed from" tracking
ALTER TABLE ventures ADD COLUMN IF NOT EXISTS venture_template_id UUID REFERENCES venture_templates(id);
CREATE INDEX IF NOT EXISTS idx_ventures_venture_template_id ON ventures(venture_template_id);
