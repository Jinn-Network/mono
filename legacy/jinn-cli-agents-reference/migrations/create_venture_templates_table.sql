-- Create venture_templates table (separate from workstream/agent templates)
CREATE TABLE IF NOT EXISTS venture_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  version TEXT DEFAULT '0.1.0',
  blueprint JSONB NOT NULL,
  enabled_tools JSONB DEFAULT '[]',
  tags TEXT[] DEFAULT '{}',
  model TEXT DEFAULT 'gemini',
  venture_id UUID REFERENCES ventures(id),
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_venture_templates_slug ON venture_templates(slug);
CREATE INDEX IF NOT EXISTS idx_venture_templates_status ON venture_templates(status);
CREATE INDEX IF NOT EXISTS idx_venture_templates_venture_id ON venture_templates(venture_id);

-- Migrate venture-type templates from templates table
INSERT INTO venture_templates (name, slug, description, version, blueprint, enabled_tools, tags, venture_id, status, created_at, updated_at)
SELECT
  name,
  slug,
  description,
  version,
  blueprint,
  enabled_tools::jsonb,
  tags,
  venture_id,
  status,
  created_at,
  updated_at
FROM templates
WHERE type = 'venture'
ON CONFLICT (slug) DO NOTHING;
