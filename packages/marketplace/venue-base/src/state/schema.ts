// SPDX-License-Identifier: MIT

// The venue state schema: the persistent submission ledger, the dual-mark chain cursor, the
// orphaned-block set the projector's correction path reads, the transactional posting-intent
// outbox and the cross-process broadcast lock. See `docs/superpowers/plans/2026-07-30-marketplace-venue-base.md`
// Task 6 for the design rationale behind each table.
export const VENUE_STATE_SCHEMA_VERSION = 1 as const;

export const SCHEMA_SQL = `
CREATE TABLE venue_state_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

-- The persistent submission ledger of the relayer profile (design §7 ruling 1), keyed exactly
-- (chainId, from, nonce). One row per EOA nonce; \`tx_hash\` is the latest submission at that
-- nonce (a fee-bumped replacement overwrites it), \`resolved_at_ms\` marks it mined.
CREATE TABLE tx_submissions (
  chain_id INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  nonce INTEGER NOT NULL CHECK (nonce >= 0),
  tx_hash TEXT,
  logical_tx TEXT,
  to_address TEXT,
  value_wei TEXT,
  data TEXT,
  max_fee_per_gas TEXT,
  max_priority_fee_per_gas TEXT,
  gas_price TEXT,
  submitted_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  PRIMARY KEY (chain_id, from_address, nonce)
);

CREATE INDEX tx_submissions_unresolved
  ON tx_submissions (chain_id, from_address, nonce)
  WHERE resolved_at_ms IS NULL;

-- The dual-mark chain cursor (design §7 ruling 2). One row per logical stream; \`live_*\` tracks
-- \`latest\` and \`finalized_*\` is the durable checkpoint a reorg rolls back to. Both carry the
-- block hash so the next poll can verify the cursor still sits on the canonical chain.
CREATE TABLE log_cursors (
  stream TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  live_block_number INTEGER NOT NULL CHECK (live_block_number >= 0),
  live_block_hash TEXT NOT NULL,
  finalized_block_number INTEGER NOT NULL CHECK (finalized_block_number >= 0),
  finalized_block_hash TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (finalized_block_number <= live_block_number)
);

-- Blocks orphaned by an observed reorg. The projector's append-only correction path
-- (\`selectCanonicalMarketplaceObservations\`) reads this set; rows are never deleted, because a
-- retraction already emitted must stay explicable.
CREATE TABLE orphaned_blocks (
  chain_id INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL CHECK (block_number >= 0),
  observed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chain_id, block_hash)
);

-- The transactional outbox (design §7 ruling 4). The idempotency key is the LOGICAL operation
-- identity carried by the sealed Submission -- never a tx hash. A row is written in the same
-- transaction as the motivating state change, strictly before broadcast; the sweeper drains
-- unresolved rows through the Safe broadcaster.
CREATE TABLE posting_intents (
  creator_safe TEXT NOT NULL,
  task_cid_digest TEXT NOT NULL,
  submission_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_task_id TEXT,
  resolved_tx_hash TEXT,
  PRIMARY KEY (creator_safe, task_cid_digest, submission_digest),
  CHECK ((resolved_task_id IS NULL) = (resolved_tx_hash IS NULL))
);

CREATE INDEX posting_intents_pending
  ON posting_intents (created_at)
  WHERE resolved_tx_hash IS NULL;

-- The cross-process broadcast lock. One row per sender EOA; a lease expires so a crashed holder
-- never wedges the sender forever.
CREATE TABLE broadcast_locks (
  chain_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  holder TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chain_id, sender)
);
`;
