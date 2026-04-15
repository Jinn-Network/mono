-- Add token-related fields to ventures table
-- Supports venture-specific tokens launched via Doppler or other platforms

ALTER TABLE ventures ADD COLUMN IF NOT EXISTS token_address TEXT;
ALTER TABLE ventures ADD COLUMN IF NOT EXISTS token_symbol TEXT;
ALTER TABLE ventures ADD COLUMN IF NOT EXISTS token_name TEXT;
ALTER TABLE ventures ADD COLUMN IF NOT EXISTS staking_contract_address TEXT;
ALTER TABLE ventures ADD COLUMN IF NOT EXISTS token_launch_platform TEXT;
ALTER TABLE ventures ADD COLUMN IF NOT EXISTS token_metadata JSONB;
ALTER TABLE ventures ADD COLUMN IF NOT EXISTS governance_address TEXT;
ALTER TABLE ventures ADD COLUMN IF NOT EXISTS pool_address TEXT;

-- Indexes for common lookups
CREATE INDEX IF NOT EXISTS idx_ventures_token_address ON ventures (token_address) WHERE token_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ventures_staking_contract ON ventures (staking_contract_address) WHERE staking_contract_address IS NOT NULL;
