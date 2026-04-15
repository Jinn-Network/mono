-- Migration: Create wishlist_wishes table
-- Purpose: Store user intents (wishes) that could be served by Jinn workstreams

CREATE TABLE IF NOT EXISTS wishlist_wishes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT NOT NULL REFERENCES wishlist_wallets(address) ON DELETE CASCADE,
  intent TEXT NOT NULL,                   -- Natural language intent from user
  context JSONB DEFAULT '{}'::jsonb,      -- Additional context (URLs, files, metadata)
  category TEXT,                          -- Auto-categorized: research, code, data, automation, etc.
  upvotes INTEGER DEFAULT 0,              -- Cached upvote count for sorting
  fulfilled_by TEXT REFERENCES job_templates(id) ON DELETE SET NULL,
  fulfilled_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'fulfilled', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_wishlist_wishes_wallet_address ON wishlist_wishes(wallet_address);
CREATE INDEX IF NOT EXISTS idx_wishlist_wishes_status ON wishlist_wishes(status);
CREATE INDEX IF NOT EXISTS idx_wishlist_wishes_upvotes ON wishlist_wishes(upvotes DESC);
CREATE INDEX IF NOT EXISTS idx_wishlist_wishes_category ON wishlist_wishes(category);
CREATE INDEX IF NOT EXISTS idx_wishlist_wishes_created_at ON wishlist_wishes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wishlist_wishes_fulfilled_by ON wishlist_wishes(fulfilled_by);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_wishlist_wishes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wishlist_wishes_updated_at ON wishlist_wishes;
CREATE TRIGGER wishlist_wishes_updated_at
  BEFORE UPDATE ON wishlist_wishes
  FOR EACH ROW
  EXECUTE FUNCTION update_wishlist_wishes_updated_at();

-- Comments for documentation
COMMENT ON TABLE wishlist_wishes IS 'User intents (wishes) that could be served by Jinn workstreams';
COMMENT ON COLUMN wishlist_wishes.intent IS 'Natural language description of what the user wants';
COMMENT ON COLUMN wishlist_wishes.context IS 'JSONB with additional context: URLs, files, metadata';
COMMENT ON COLUMN wishlist_wishes.category IS 'Auto-categorized: research, code, data, automation, etc.';
COMMENT ON COLUMN wishlist_wishes.upvotes IS 'Cached upvote count (updated by triggers/application)';
COMMENT ON COLUMN wishlist_wishes.fulfilled_by IS 'Reference to job_template that fulfills this wish';
COMMENT ON COLUMN wishlist_wishes.status IS 'Lifecycle: pending, processing, fulfilled, rejected';
