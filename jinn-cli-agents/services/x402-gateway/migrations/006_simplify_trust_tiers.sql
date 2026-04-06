-- Simplify trust tiers to binary (untrusted/trusted).
-- Safety migration: cleans up any legacy 4-tier enum values and staking columns
-- if the old 004 was run before this simplification.
--
-- Run after 005_seed_credential_policies.sql
-- Idempotent: safe to run on fresh or pre-existing databases.

-- Remove staking columns if they exist
ALTER TABLE operators DROP COLUMN IF EXISTS staking_contract;
ALTER TABLE operators DROP COLUMN IF EXISTS stake_verified_at;
DROP INDEX IF EXISTS idx_operators_staking;

-- Collapse any legacy tier values into the binary model.
-- Cast to text before comparing so PostgreSQL does not reject unknown enum
-- literals on fresh databases where the enum only has (untrusted, trusted).
UPDATE operators SET trust_tier = 'trusted' WHERE trust_tier::text IN ('staked', 'premium');
UPDATE operators SET trust_tier = 'untrusted' WHERE trust_tier::text = 'unverified';
UPDATE operators SET tier_override = 'trusted' WHERE tier_override::text IN ('staked', 'premium');
UPDATE operators SET tier_override = 'untrusted' WHERE tier_override::text = 'unverified';
UPDATE credential_policies SET min_trust_tier = 'trusted' WHERE min_trust_tier::text IN ('staked', 'premium', 'unverified');
UPDATE venture_credentials SET min_trust_tier = 'trusted' WHERE min_trust_tier::text IN ('staked', 'premium', 'unverified');
UPDATE credential_grants SET trust_tier_at_grant = 'trusted' WHERE trust_tier_at_grant::text IN ('staked', 'premium');
UPDATE credential_grants SET trust_tier_at_grant = 'untrusted' WHERE trust_tier_at_grant::text = 'unverified';
