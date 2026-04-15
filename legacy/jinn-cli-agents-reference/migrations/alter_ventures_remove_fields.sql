-- Migration: Alter ventures table - remove unused fields, rename job_template_id
-- Purpose: Simplify ventures schema by removing config, tags, featured and renaming job_template_id to root_job_instance_id

-- Step 1: Drop indexes on fields being removed
DROP INDEX IF EXISTS idx_ventures_featured;
DROP INDEX IF EXISTS idx_ventures_tags;

-- Step 2: Rename job_template_id to root_job_instance_id
ALTER TABLE ventures RENAME COLUMN job_template_id TO root_job_instance_id;

-- Step 3: Remove columns
ALTER TABLE ventures DROP COLUMN IF EXISTS config;
ALTER TABLE ventures DROP COLUMN IF EXISTS tags;
ALTER TABLE ventures DROP COLUMN IF EXISTS featured;

-- Step 4: Update column comments
COMMENT ON COLUMN ventures.root_job_instance_id IS 'Optional reference to the root job instance for this venture';

-- Schema verification (for documentation):
-- After this migration, ventures table should have:
--   id UUID PRIMARY KEY
--   name TEXT NOT NULL
--   slug TEXT UNIQUE NOT NULL
--   description TEXT
--   owner_address TEXT NOT NULL
--   blueprint JSONB NOT NULL
--   root_workstream_id TEXT
--   root_job_instance_id TEXT (renamed from job_template_id)
--   status TEXT DEFAULT 'active'
--   created_at TIMESTAMPTZ
--   updated_at TIMESTAMPTZ
