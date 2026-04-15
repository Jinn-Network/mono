-- Credential Management Layer
-- Adds operator trust tiers, global credential policies, venture-scoped credentials,
-- operator whitelists/blocklists, and admin audit logging.
--
-- Run against the ACL database (same as credential_grants):
--   Local:   psql postgres://nango:nango@localhost:5434/nango -f migrations/004_credential_management.sql
--   Railway: ACL_DATABASE_URL

-- Enum types
DO $$ BEGIN
  CREATE TYPE trust_tier AS ENUM ('untrusted', 'trusted');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE access_mode AS ENUM ('venture_only', 'union_with_global');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- operators: registered operator identities with trust tiers
-- ============================================================
CREATE TABLE IF NOT EXISTS operators (
  address TEXT PRIMARY KEY CHECK (address = lower(address)),
  service_id BIGINT,
  trust_tier trust_tier NOT NULL DEFAULT 'untrusted',
  tier_override trust_tier,
  whitelisted BOOLEAN NOT NULL DEFAULT false,
  whitelisted_by TEXT CHECK (whitelisted_by IS NULL OR whitelisted_by = lower(whitelisted_by)),
  whitelisted_at TIMESTAMPTZ,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operators_tier ON operators(trust_tier);

-- ============================================================
-- credential_policies: global rules for auto-provisioning
-- ============================================================
CREATE TABLE IF NOT EXISTS credential_policies (
  provider TEXT PRIMARY KEY,
  min_trust_tier trust_tier NOT NULL DEFAULT 'trusted',
  auto_grant BOOLEAN NOT NULL DEFAULT false,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  default_price TEXT NOT NULL DEFAULT '0',
  default_nango_connection TEXT,
  max_requests_per_minute INT NOT NULL DEFAULT 10,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- venture_credentials: venture-scoped OAuth connections
-- ============================================================
CREATE TABLE IF NOT EXISTS venture_credentials (
  venture_id UUID NOT NULL,
  provider TEXT NOT NULL,
  nango_connection_id TEXT,
  min_trust_tier trust_tier NOT NULL DEFAULT 'trusted',
  access_mode access_mode NOT NULL DEFAULT 'venture_only',
  price_per_access TEXT NOT NULL DEFAULT '0',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (venture_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_vc_venture ON venture_credentials(venture_id) WHERE active = true;

-- ============================================================
-- venture_credential_operators: per-venture whitelist/blocklist
-- ============================================================
CREATE TABLE IF NOT EXISTS venture_credential_operators (
  venture_id UUID NOT NULL,
  provider TEXT NOT NULL,
  operator_address TEXT NOT NULL CHECK (operator_address = lower(operator_address)),
  status TEXT NOT NULL DEFAULT 'allowed' CHECK (status IN ('allowed', 'blocked')),
  granted_by TEXT NOT NULL CHECK (granted_by = lower(granted_by)),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (venture_id, provider, operator_address),
  FOREIGN KEY (venture_id, provider) REFERENCES venture_credentials(venture_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_vco_operator ON venture_credential_operators(operator_address);
CREATE INDEX IF NOT EXISTS idx_vco_blocked ON venture_credential_operators(venture_id, provider) WHERE status = 'blocked';

-- ============================================================
-- admin_audit_log: tracks all admin mutations with before/after
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  actor_address TEXT NOT NULL CHECK (actor_address = lower(actor_address)),
  target_address TEXT CHECK (target_address IS NULL OR target_address = lower(target_address)),
  target_venture_id UUID,
  target_provider TEXT,
  before_state JSONB,
  after_state JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_log(actor_address);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_log(target_address) WHERE target_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at);

-- ============================================================
-- Extend credential_grants with management metadata
-- ============================================================
ALTER TABLE credential_grants
  ADD COLUMN IF NOT EXISTS venture_id UUID,
  ADD COLUMN IF NOT EXISTS auto_provisioned BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS provisioned_by TEXT,
  ADD COLUMN IF NOT EXISTS trust_tier_at_grant trust_tier;

-- Enforce lowercase on existing address column (idempotent via unique name)
DO $$ BEGIN
  ALTER TABLE credential_grants ADD CONSTRAINT chk_grants_address_lower CHECK (address = lower(address));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
