-- Migration: Create wishlist_points table
-- Purpose: Points ledger tracking all point awards for wishlist participants

CREATE TABLE IF NOT EXISTS wishlist_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT NOT NULL REFERENCES wishlist_wallets(address) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('wish_created', 'upvote_received', 'fulfilled', 'executed', 'referral')),
  points INTEGER NOT NULL,
  wish_id UUID REFERENCES wishlist_wishes(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_wishlist_points_wallet_address ON wishlist_points(wallet_address);
CREATE INDEX IF NOT EXISTS idx_wishlist_points_reason ON wishlist_points(reason);
CREATE INDEX IF NOT EXISTS idx_wishlist_points_wish_id ON wishlist_points(wish_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_points_created_at ON wishlist_points(created_at DESC);

-- Comments for documentation
COMMENT ON TABLE wishlist_points IS 'Points ledger for wishlist participants';
COMMENT ON COLUMN wishlist_points.reason IS 'Point award reason: wish_created (10), upvote_received (1), fulfilled (50), executed (5), referral (100)';
COMMENT ON COLUMN wishlist_points.points IS 'Number of points awarded (can be negative for deductions)';
COMMENT ON COLUMN wishlist_points.wish_id IS 'Optional reference to related wish';
