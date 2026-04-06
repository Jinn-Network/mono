-- Migration: Create interfaces table
-- Purpose: Store API interfaces exposed by services (MCP tools, REST endpoints, etc.)

CREATE TABLE IF NOT EXISTS interfaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  interface_type TEXT NOT NULL CHECK (interface_type IN ('mcp_tool', 'rest_endpoint', 'graphql', 'grpc', 'websocket', 'webhook', 'other')),
  description TEXT,

  -- For MCP tools
  mcp_schema JSONB,                         -- MCP tool input schema

  -- For REST/HTTP endpoints
  http_method TEXT,                         -- GET, POST, PUT, DELETE, PATCH
  http_path TEXT,                           -- /api/v1/resource

  -- For all interface types
  input_schema JSONB,                       -- JSON Schema for inputs
  output_schema JSONB,                      -- JSON Schema for outputs
  auth_required BOOLEAN DEFAULT false,
  auth_type TEXT,                           -- bearer, api_key, oauth, x402, none
  rate_limit JSONB,                         -- Rate limit configuration

  -- Pricing (for x402 or paid endpoints)
  x402_price BIGINT DEFAULT 0,              -- Price in wei

  config JSONB DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'removed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(service_id, name)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_interfaces_service_id ON interfaces(service_id);
CREATE INDEX IF NOT EXISTS idx_interfaces_interface_type ON interfaces(interface_type);
CREATE INDEX IF NOT EXISTS idx_interfaces_name ON interfaces(name);
CREATE INDEX IF NOT EXISTS idx_interfaces_status ON interfaces(status);
CREATE INDEX IF NOT EXISTS idx_interfaces_auth_type ON interfaces(auth_type);
CREATE INDEX IF NOT EXISTS idx_interfaces_tags ON interfaces USING GIN(tags);

-- Full-text search on name and description
CREATE INDEX IF NOT EXISTS idx_interfaces_search ON interfaces USING GIN(to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '')));

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_interfaces_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS interfaces_updated_at ON interfaces;
CREATE TRIGGER interfaces_updated_at
  BEFORE UPDATE ON interfaces
  FOR EACH ROW
  EXECUTE FUNCTION update_interfaces_updated_at();

-- Comments for documentation
COMMENT ON TABLE interfaces IS 'API interfaces exposed by services';
COMMENT ON COLUMN interfaces.interface_type IS 'Type: mcp_tool, rest_endpoint, graphql, grpc, websocket, webhook, or other';
COMMENT ON COLUMN interfaces.mcp_schema IS 'MCP tool schema for MCP tool interfaces';
COMMENT ON COLUMN interfaces.http_method IS 'HTTP method for REST endpoints';
COMMENT ON COLUMN interfaces.http_path IS 'HTTP path pattern for REST endpoints';
COMMENT ON COLUMN interfaces.input_schema IS 'JSON Schema defining the expected input';
COMMENT ON COLUMN interfaces.output_schema IS 'JSON Schema defining the expected output';
COMMENT ON COLUMN interfaces.auth_required IS 'Whether authentication is required';
COMMENT ON COLUMN interfaces.auth_type IS 'Authentication type: bearer, api_key, oauth, x402, or none';
COMMENT ON COLUMN interfaces.rate_limit IS 'Rate limiting configuration as JSONB';
COMMENT ON COLUMN interfaces.x402_price IS 'Price in wei for x402 payment protocol';
