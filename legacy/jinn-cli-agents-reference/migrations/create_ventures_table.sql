-- Migration: Create ventures table
-- Purpose: Store venture definitions with blueprints and workstream references

CREATE TABLE IF NOT EXISTS ventures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  owner_address TEXT NOT NULL,              -- Ethereum address
  blueprint JSONB NOT NULL,                 -- Invariants schema
  root_workstream_id TEXT,                  -- Single workstream reference
  root_job_instance_id TEXT,                -- Optional root job instance reference
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_ventures_slug ON ventures(slug);
CREATE INDEX IF NOT EXISTS idx_ventures_owner_address ON ventures(owner_address);
CREATE INDEX IF NOT EXISTS idx_ventures_status ON ventures(status);
CREATE INDEX IF NOT EXISTS idx_ventures_created_at ON ventures(created_at DESC);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_ventures_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ventures_updated_at ON ventures;
CREATE TRIGGER ventures_updated_at
  BEFORE UPDATE ON ventures
  FOR EACH ROW
  EXECUTE FUNCTION update_ventures_updated_at();

-- Comments for documentation
COMMENT ON TABLE ventures IS 'Venture definitions with blueprints and workstream references';
COMMENT ON COLUMN ventures.owner_address IS 'Ethereum address of the venture owner';
COMMENT ON COLUMN ventures.blueprint IS 'JSONB containing invariants schema for the venture';
COMMENT ON COLUMN ventures.root_workstream_id IS 'Single workstream reference - cyclic re-dispatches stay in same workstream';
COMMENT ON COLUMN ventures.root_job_instance_id IS 'Optional reference to the root job instance for this venture';
COMMENT ON COLUMN ventures.status IS 'Lifecycle status: active, paused, or archived';
