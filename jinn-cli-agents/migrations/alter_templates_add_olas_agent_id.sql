-- Add olas_agent_id column to templates table
-- Stores the OLAS Agent Registry agent ID after minting
ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS olas_agent_id INTEGER;

-- Index for looking up templates by their OLAS agent ID
CREATE INDEX IF NOT EXISTS idx_templates_olas_agent_id
  ON templates (olas_agent_id)
  WHERE olas_agent_id IS NOT NULL;

COMMENT ON COLUMN templates.olas_agent_id IS
  'OLAS Agent Registry agent ID (minted via scripts/mint-olas-agent.ts). NULL if not yet registered on-chain.';
