-- Add typed attribution columns for credential audit analytics.
-- Keeps legacy metadata JSONB while adding queryable fields.

ALTER TABLE credential_audit_log
  ADD COLUMN IF NOT EXISTS request_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_required_amount TEXT,
  ADD COLUMN IF NOT EXISTS payment_paid_amount TEXT,
  ADD COLUMN IF NOT EXISTS payment_payer TEXT,
  ADD COLUMN IF NOT EXISTS payment_network TEXT,
  ADD COLUMN IF NOT EXISTS payment_error_code TEXT,
  ADD COLUMN IF NOT EXISTS payment_error_message TEXT,
  ADD COLUMN IF NOT EXISTS verification_state TEXT,
  ADD COLUMN IF NOT EXISTS verification_error TEXT,
  ADD COLUMN IF NOT EXISTS verification_detail TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_request_id
  ON credential_audit_log(request_id);

CREATE INDEX IF NOT EXISTS idx_audit_verification_state
  ON credential_audit_log(verification_state);
