-- Job Templates Registry
-- Stores reusable job template definitions for the x402 marketplace
-- Templates are immutable once published (status: visible/hidden for lifecycle)

CREATE TABLE IF NOT EXISTS job_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  tags TEXT[] DEFAULT '{}',
  
  -- Tool policy: JSON array of allowed tool names
  enabled_tools_policy JSONB DEFAULT '[]'::jsonb,
  
  -- Input contract: JSON Schema defining expected inputs
  input_schema JSONB DEFAULT '{}'::jsonb,
  
  -- Output contract: schema + mapping for deterministic response extraction
  output_spec JSONB DEFAULT '{}'::jsonb,
  
  -- Pricing: in wei (derived from historical runs)
  x402_price BIGINT DEFAULT 0,
  
  -- Safety tier: "public" (restricted tools), "private" (full tools), "restricted" (no shell/git)
  safety_tier TEXT DEFAULT 'public' CHECK (safety_tier IN ('public', 'private', 'restricted')),
  
  -- Visibility: "visible" (listed in catalog), "hidden" (not listed but callable)
  status TEXT DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  
  -- Optional link to a canonical job definition (example instance)
  canonical_job_definition_id TEXT,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_job_templates_status ON job_templates(status);
CREATE INDEX IF NOT EXISTS idx_job_templates_safety_tier ON job_templates(safety_tier);
CREATE INDEX IF NOT EXISTS idx_job_templates_tags ON job_templates USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_job_templates_created_at ON job_templates(created_at DESC);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_job_templates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_templates_updated_at ON job_templates;
CREATE TRIGGER job_templates_updated_at
  BEFORE UPDATE ON job_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_job_templates_updated_at();

-- Comments for documentation
COMMENT ON TABLE job_templates IS 'Reusable job template definitions for x402 marketplace';
COMMENT ON COLUMN job_templates.enabled_tools_policy IS 'JSON array of tool names allowed for this template';
COMMENT ON COLUMN job_templates.input_schema IS 'JSON Schema defining the expected input structure';
COMMENT ON COLUMN job_templates.output_spec IS 'Output contract: {schema: JSONSchema, mapping: {field: selector}}';
COMMENT ON COLUMN job_templates.x402_price IS 'Price in wei (computed from historical run costs)';
COMMENT ON COLUMN job_templates.safety_tier IS 'Security tier: public (restricted), private (full), restricted (no shell/git)';

