-- Credential Bridge ACL Tables
-- Run against Nango's Postgres database.
--
-- Local dev:  psql postgres://nango:nango@localhost:5434/nango -f migrations/create_credential_acl_tables.sql
-- Railway:    Same Postgres that Nango uses (ACL_DATABASE_URL env var)

CREATE TABLE IF NOT EXISTS credential_grants (
  address TEXT NOT NULL,
  provider TEXT NOT NULL,
  nango_connection_id TEXT NOT NULL,
  price_per_access TEXT NOT NULL DEFAULT '0',
  expires_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (address, provider)
);

CREATE TABLE IF NOT EXISTS credential_connections (
  connection_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credential_grants_active
  ON credential_grants(address, active) WHERE active = true;
