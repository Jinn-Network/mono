-- Migration: Create services table
-- Purpose: Store service definitions owned by ventures

CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venture_id UUID NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  service_type TEXT NOT NULL CHECK (service_type IN ('mcp', 'api', 'worker', 'frontend', 'library', 'other')),
  repository_url TEXT,
  primary_language TEXT,
  version TEXT,
  config JSONB DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'archived')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(venture_id, slug)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_services_venture_id ON services(venture_id);
CREATE INDEX IF NOT EXISTS idx_services_slug ON services(slug);
CREATE INDEX IF NOT EXISTS idx_services_service_type ON services(service_type);
CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);
CREATE INDEX IF NOT EXISTS idx_services_tags ON services USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_services_created_at ON services(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_services_primary_language ON services(primary_language);

-- Full-text search index on name and description
CREATE INDEX IF NOT EXISTS idx_services_search ON services USING GIN(to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '')));

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_services_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS services_updated_at ON services;
CREATE TRIGGER services_updated_at
  BEFORE UPDATE ON services
  FOR EACH ROW
  EXECUTE FUNCTION update_services_updated_at();

-- Comments for documentation
COMMENT ON TABLE services IS 'Service definitions owned by ventures';
COMMENT ON COLUMN services.venture_id IS 'Reference to the owning venture';
COMMENT ON COLUMN services.service_type IS 'Type: mcp (MCP server), api, worker, frontend, library, or other';
COMMENT ON COLUMN services.repository_url IS 'Git repository URL for the service source code';
COMMENT ON COLUMN services.primary_language IS 'Primary programming language (e.g., typescript, python, go)';
COMMENT ON COLUMN services.version IS 'Current semantic version';
COMMENT ON COLUMN services.config IS 'Service-specific configuration as JSONB';
COMMENT ON COLUMN services.status IS 'Lifecycle status: active, deprecated, or archived';
