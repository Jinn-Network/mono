-- Create templates table for reusable, static template definitions
-- Separate from job_templates (Ponder on-chain metrics) and job_templates (x402-gateway)

CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  version TEXT DEFAULT '0.1.0',
  blueprint JSONB NOT NULL,
  input_schema JSONB DEFAULT '{}',
  output_spec JSONB DEFAULT '{}',
  enabled_tools JSONB DEFAULT '[]',
  tags TEXT[] DEFAULT '{}',
  price_wei TEXT,
  price_usd TEXT,
  safety_tier TEXT DEFAULT 'public' CHECK (safety_tier IN ('public', 'private', 'restricted')),
  default_cyclic BOOLEAN DEFAULT false,
  venture_id UUID REFERENCES ventures(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_templates_slug ON templates(slug);
CREATE INDEX IF NOT EXISTS idx_templates_status ON templates(status);
CREATE INDEX IF NOT EXISTS idx_templates_safety_tier ON templates(safety_tier);
CREATE INDEX IF NOT EXISTS idx_templates_venture_id ON templates(venture_id);
CREATE INDEX IF NOT EXISTS idx_templates_tags ON templates USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_templates_created_at ON templates(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_templates_fulltext ON templates USING GIN(to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '')));

-- Auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION update_templates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS templates_updated_at ON templates;
CREATE TRIGGER templates_updated_at
  BEFORE UPDATE ON templates
  FOR EACH ROW
  EXECUTE FUNCTION update_templates_updated_at();
