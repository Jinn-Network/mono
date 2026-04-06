-- Create table for tracking venture dispatch claims (prevents duplicate scheduled dispatches)
-- The unique constraint on (venture_id, template_id, schedule_tick) ensures only one worker
-- can claim a particular cron tick for a given venture + template combination.
CREATE TABLE IF NOT EXISTS venture_dispatch_claims (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  venture_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  schedule_tick TEXT NOT NULL,
  worker_address TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
  UNIQUE (venture_id, template_id, schedule_tick)
);

-- Index for expiration cleanup queries
CREATE INDEX IF NOT EXISTS idx_vdc_expires ON venture_dispatch_claims(expires_at);

-- Index for lookup by venture + template
CREATE INDEX IF NOT EXISTS idx_vdc_venture_template ON venture_dispatch_claims(venture_id, template_id);

-- Enable RLS (though mostly used by service role)
ALTER TABLE venture_dispatch_claims ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role full access" ON venture_dispatch_claims
  USING (true)
  WITH CHECK (true);
