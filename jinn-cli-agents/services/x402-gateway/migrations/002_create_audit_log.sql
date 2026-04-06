-- Audit Log for Credential Bridge
-- Tracks all credential access attempts for security monitoring and forensics

CREATE TABLE IF NOT EXISTS credential_audit_log (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  address TEXT NOT NULL,
  provider TEXT NOT NULL,
  action TEXT NOT NULL,  -- 'token_issued', 'auth_failed', 'rate_limited', 'payment_required', 'payment_invalid', 'not_authorized', 'nango_error'
  ip TEXT,
  user_agent TEXT,
  nonce TEXT,
  metadata JSONB  -- error details, payment amount, etc.
);

-- Index for querying by agent address (who accessed what)
CREATE INDEX IF NOT EXISTS idx_audit_address ON credential_audit_log(address);

-- Index for time-range queries (incident response)
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON credential_audit_log(timestamp);

-- Index for filtering by action type (abuse detection)
CREATE INDEX IF NOT EXISTS idx_audit_action ON credential_audit_log(action);

-- Composite index for common query pattern: address + time range
CREATE INDEX IF NOT EXISTS idx_audit_address_timestamp ON credential_audit_log(address, timestamp);
