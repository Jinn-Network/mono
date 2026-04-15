-- Add dispatch_schedule column to ventures table
-- This enables cron-triggered template dispatches for ventures.
-- Default is empty array: existing ventures continue unaffected.

ALTER TABLE ventures ADD COLUMN IF NOT EXISTS dispatch_schedule JSONB DEFAULT '[]';

-- Add an index for efficient querying of ventures with non-empty schedules
CREATE INDEX IF NOT EXISTS idx_ventures_dispatch_schedule
  ON ventures USING gin (dispatch_schedule)
  WHERE dispatch_schedule != '[]'::jsonb;
