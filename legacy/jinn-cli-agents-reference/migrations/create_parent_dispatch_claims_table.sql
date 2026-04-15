-- Create table for tracking parent dispatch claims
CREATE TABLE IF NOT EXISTS parent_dispatch_claims (
  parent_job_def_id TEXT PRIMARY KEY,
  child_job_def_id TEXT NOT NULL,
  worker_address TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes')
);

-- Index for expiration queries
CREATE INDEX IF NOT EXISTS idx_pdc_expires ON parent_dispatch_claims(expires_at);

-- Enable RLS (though mostly used by service role)
ALTER TABLE parent_dispatch_claims ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role full access" ON parent_dispatch_claims
  USING (true)
  WITH CHECK (true);
