-- Migration: Create wishlist_wallets table
-- Purpose: Store wallet addresses for wishlist participants (Create2 addresses)
-- Note: Private keys are stored locally on user devices, never sent to server

CREATE TABLE IF NOT EXISTS wishlist_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address TEXT UNIQUE NOT NULL,           -- 0x... address (Create2 computed)
  public_key TEXT,                        -- For signature verification
  deployed BOOLEAN DEFAULT FALSE,         -- Whether Create2 has been executed on-chain
  total_points INTEGER DEFAULT 0,         -- Cached total for leaderboard queries
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_wishlist_wallets_address ON wishlist_wallets(address);
CREATE INDEX IF NOT EXISTS idx_wishlist_wallets_total_points ON wishlist_wallets(total_points DESC);
CREATE INDEX IF NOT EXISTS idx_wishlist_wallets_created_at ON wishlist_wallets(created_at DESC);

-- Comments for documentation
COMMENT ON TABLE wishlist_wallets IS 'Wallet addresses for wishlist participants using Create2';
COMMENT ON COLUMN wishlist_wallets.address IS 'Ethereum address (Create2 computed, 0x prefixed)';
COMMENT ON COLUMN wishlist_wallets.public_key IS 'Public key for signature verification';
COMMENT ON COLUMN wishlist_wallets.deployed IS 'Whether the Create2 contract has been deployed on-chain';
COMMENT ON COLUMN wishlist_wallets.total_points IS 'Cached total points for leaderboard (updated on point changes)';
