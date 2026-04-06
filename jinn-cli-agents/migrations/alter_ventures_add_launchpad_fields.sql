-- Expand status constraint to support launchpad lifecycle
-- Adds 'proposed' (no token yet) and 'bonding' (Doppler curve active) statuses
ALTER TABLE ventures DROP CONSTRAINT IF EXISTS ventures_status_check;
ALTER TABLE ventures ADD CONSTRAINT ventures_status_check
  CHECK (status IN ('proposed', 'bonding', 'active', 'paused', 'archived'));

-- Track whether venture was created by human or agent delegate
ALTER TABLE ventures ADD COLUMN IF NOT EXISTS creator_type TEXT
  DEFAULT 'human' CHECK (creator_type IN ('human', 'delegate'));
