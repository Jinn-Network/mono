-- Add partial index for allowed operator lookups in venture credential access checks.
-- Run after 006_simplify_trust_tiers.sql
-- Idempotent: safe to run on fresh or pre-existing databases.
--
-- The checkVentureAccess() function queries venture_credential_operators
-- for status='blocked' and status='allowed' separately. The blocked index
-- already exists (idx_vco_blocked); this adds the allowed counterpart.

CREATE INDEX IF NOT EXISTS idx_vco_allowed
  ON venture_credential_operators(venture_id, provider)
  WHERE status = 'allowed';
