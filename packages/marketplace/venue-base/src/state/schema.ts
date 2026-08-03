// SPDX-License-Identifier: MIT

// The venue state schema: the persistent submission ledger, the dual-mark chain cursor, the
// orphaned-block set the projector's correction path reads, the transactional posting-intent
// outbox and the cross-process broadcast lock. See `docs/superpowers/plans/2026-07-30-marketplace-venue-base.md`
// Task 6 for the design rationale behind each table. Task 13 adds `cancel_signals` (schema
// version 2): the durable, idempotent requester cancellation signal. Task 16 adds
// `submission_scopes` and `attempt_deliveries` (schema version 3): the durable half of the
// projector-backed `MarketplaceObservePort` -- linearizable requester-scope ownership and
// recorded Delivery bytes. Version 4 adds scanned block-number/hash history so reorg handling
// can enumerate every displaced block, including blocks with no marketplace logs.
export const VENUE_STATE_SCHEMA_VERSION = 5 as const;

/** Additive v3 -> v4 migration; old venue state must retain every existing cursor/outbox row. */
export const VENUE_STATE_V4_MIGRATION_SQL = `
CREATE TABLE scanned_block_hashes (
  stream TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL,
  orphaned_at_ms INTEGER,
  PRIMARY KEY (stream, block_number, block_hash)
);
CREATE INDEX scanned_block_hashes_active_range
  ON scanned_block_hashes (stream, block_number)
  WHERE orphaned_at_ms IS NULL;
`;

/** Additive v4 -> v5 migration. Unresolved legacy scopes are retained but fail closed. */
export const VENUE_STATE_V5_MIGRATION_SQL = `
ALTER TABLE posting_intents ADD COLUMN venue_namespace TEXT;
ALTER TABLE posting_intents ADD COLUMN command_digest TEXT;
ALTER TABLE posting_intents ADD COLUMN command_json TEXT;
ALTER TABLE posting_intents ADD COLUMN legacy_unrecoverable INTEGER NOT NULL DEFAULT 0
  CHECK (legacy_unrecoverable IN (0, 1));
UPDATE posting_intents
SET legacy_unrecoverable = 1
WHERE resolved_tx_hash IS NULL;
ALTER TABLE submission_scopes ADD COLUMN task_digest TEXT;
ALTER TABLE submission_scopes ADD COLUMN creator_safe TEXT;
ALTER TABLE submission_scopes ADD COLUMN venue_namespace TEXT;
ALTER TABLE submission_scopes ADD COLUMN command_digest TEXT;
ALTER TABLE submission_scopes ADD COLUMN posting_intent_key TEXT;
ALTER TABLE submission_scopes ADD COLUMN legacy_scope_unrecoverable INTEGER NOT NULL DEFAULT 0
  CHECK (legacy_scope_unrecoverable IN (0, 1));
UPDATE submission_scopes
SET legacy_scope_unrecoverable = 1
WHERE resolved_at_ms IS NULL;
`;

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

-- Canonical block provenance sampled as the log cursor advances. \`getLogs\` cannot tell us the
-- hash of an empty block, and after a fork the RPC exposes only replacement hashes; retaining
-- this history is therefore the only way to enumerate the full displaced suffix. A later
-- finalized-boundary prune may remove rows only at or below that boundary, where they can no
-- longer be reorged. Orphaned rows remain independently auditable in \`orphaned_blocks\`.
CREATE TABLE scanned_block_hashes (
  stream TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL,
  orphaned_at_ms INTEGER,
  PRIMARY KEY (stream, block_number, block_hash)
);
CREATE INDEX scanned_block_hashes_active_range
  ON scanned_block_hashes (stream, block_number)
  WHERE orphaned_at_ms IS NULL;

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
  venue_namespace TEXT,
  command_digest TEXT,
  command_json TEXT,
  legacy_unrecoverable INTEGER NOT NULL DEFAULT 0
    CHECK (legacy_unrecoverable IN (0, 1)),
  resolved_task_id TEXT,
  resolved_tx_hash TEXT,
  PRIMARY KEY (creator_safe, task_cid_digest, submission_digest),
  CHECK ((resolved_task_id IS NULL) = (resolved_tx_hash IS NULL))
);

CREATE INDEX posting_intents_pending
  ON posting_intents (created_at)
  WHERE resolved_tx_hash IS NULL;

-- Requester cancellation is a durable, idempotent signal; it never revokes a live attempt.
-- The row IS the signal: a restart or replay reads it back and returns \`already-requested\`
-- without emitting a second one.
CREATE TABLE cancel_signals (
  attempt TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
  reason TEXT NOT NULL,
  requested_at_ms INTEGER NOT NULL
);

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

-- Linearizable requester-scope ownership (TEP §12.2 idempotent resubmission). Matching is by
-- EXACT Submission bytes, never by field equality: \`submission_bytes\` is the identity.
CREATE TABLE submission_scopes (
  requester TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  submission_uri TEXT NOT NULL,
  digest TEXT NOT NULL,
  submission_bytes BLOB NOT NULL,
  owner_token TEXT NOT NULL,
  resolved_at_ms INTEGER,
  resolved_task_id TEXT,
  resolved_tx_hash TEXT,
  engagement_attempt TEXT,
  dispatch_context_json TEXT,
  task_digest TEXT NOT NULL,
  creator_safe TEXT NOT NULL,
  venue_namespace TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  posting_intent_key TEXT NOT NULL,
  legacy_scope_unrecoverable INTEGER NOT NULL DEFAULT 0
    CHECK (legacy_scope_unrecoverable IN (0, 1)),
  PRIMARY KEY (requester, idempotency_key)
);

-- Recorded Delivery bytes per Attempt, addressed by their own sha256 digest.
CREATE TABLE attempt_deliveries (
  attempt TEXT NOT NULL,
  digest TEXT NOT NULL,
  delivery_bytes BLOB NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  PRIMARY KEY (attempt, digest)
);
`;
