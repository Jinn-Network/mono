-- Migration: Create deployments table
-- Purpose: Store deployment instances of services (Railway, Vercel, etc.)

CREATE TABLE IF NOT EXISTS deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('production', 'staging', 'development', 'preview')),
  provider TEXT NOT NULL CHECK (provider IN ('railway', 'vercel', 'cloudflare', 'aws', 'gcp', 'azure', 'self-hosted', 'other')),
  provider_project_id TEXT,                 -- Railway project ID, Vercel project ID, etc.
  provider_service_id TEXT,                 -- Railway service ID, etc.
  url TEXT,                                 -- Primary deployment URL
  urls JSONB DEFAULT '[]',                  -- Array of all URLs for this deployment
  version TEXT,                             -- Deployed version
  config JSONB DEFAULT '{}',                -- Provider-specific configuration
  health_check_url TEXT,                    -- Health check endpoint
  last_health_check TIMESTAMPTZ,            -- Last health check timestamp
  health_status TEXT DEFAULT 'unknown' CHECK (health_status IN ('healthy', 'unhealthy', 'degraded', 'unknown')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'failed', 'deploying')),
  deployed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_deployments_service_id ON deployments(service_id);
CREATE INDEX IF NOT EXISTS idx_deployments_environment ON deployments(environment);
CREATE INDEX IF NOT EXISTS idx_deployments_provider ON deployments(provider);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
CREATE INDEX IF NOT EXISTS idx_deployments_health_status ON deployments(health_status);
CREATE INDEX IF NOT EXISTS idx_deployments_provider_project_id ON deployments(provider_project_id);
CREATE INDEX IF NOT EXISTS idx_deployments_deployed_at ON deployments(deployed_at DESC);

-- Unique constraint for one deployment per service+environment (optional, remove if multiple allowed)
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_service_env ON deployments(service_id, environment) WHERE status = 'active';

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_deployments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deployments_updated_at ON deployments;
CREATE TRIGGER deployments_updated_at
  BEFORE UPDATE ON deployments
  FOR EACH ROW
  EXECUTE FUNCTION update_deployments_updated_at();

-- Comments for documentation
COMMENT ON TABLE deployments IS 'Deployment instances of services across different providers and environments';
COMMENT ON COLUMN deployments.environment IS 'Deployment environment: production, staging, development, or preview';
COMMENT ON COLUMN deployments.provider IS 'Infrastructure provider: railway, vercel, cloudflare, aws, gcp, azure, self-hosted, or other';
COMMENT ON COLUMN deployments.provider_project_id IS 'Provider-specific project identifier (e.g., Railway project ID)';
COMMENT ON COLUMN deployments.provider_service_id IS 'Provider-specific service identifier (e.g., Railway service ID)';
COMMENT ON COLUMN deployments.url IS 'Primary URL for the deployment';
COMMENT ON COLUMN deployments.urls IS 'JSONB array of all URLs associated with this deployment';
COMMENT ON COLUMN deployments.health_check_url IS 'Endpoint for health checks';
COMMENT ON COLUMN deployments.health_status IS 'Current health: healthy, unhealthy, degraded, or unknown';
COMMENT ON COLUMN deployments.status IS 'Deployment status: active, stopped, failed, or deploying';
