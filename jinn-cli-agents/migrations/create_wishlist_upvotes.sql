-- Migration: Create wishlist_upvotes table
-- Purpose: Track individual upvotes on wishes (one per wallet per wish)

CREATE TABLE IF NOT EXISTS wishlist_upvotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wish_id UUID NOT NULL REFERENCES wishlist_wishes(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL REFERENCES wishlist_wallets(address) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(wish_id, wallet_address)         -- One upvote per wallet per wish
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_wishlist_upvotes_wish_id ON wishlist_upvotes(wish_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_upvotes_wallet_address ON wishlist_upvotes(wallet_address);
CREATE INDEX IF NOT EXISTS idx_wishlist_upvotes_created_at ON wishlist_upvotes(created_at DESC);

-- Comments for documentation
COMMENT ON TABLE wishlist_upvotes IS 'Individual upvotes on wishes (one per wallet per wish)';
COMMENT ON COLUMN wishlist_upvotes.wish_id IS 'Reference to the wish being upvoted';
COMMENT ON COLUMN wishlist_upvotes.wallet_address IS 'Wallet address of the upvoter';
