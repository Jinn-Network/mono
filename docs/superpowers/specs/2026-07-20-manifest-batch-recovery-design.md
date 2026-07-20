# Manifest batch recovery hardening (#1829)

Date: 2026-07-20

## Context

Manifest publication already freezes each canonical body below Kubo's 256 KiB raw-block
boundary and verifies its raw CID before broadcasting. Three recovery gaps remain: the CID
decoder accepts non-canonical encodings, partial member uploads can escape without recovery
facts, and a retry after one split partition succeeds starts again at partition zero.

## Chosen design

Manifest mode uses a durable SQLite journal keyed by `batchKind`, the ordered immutable source
identities supplied by the bridge (`requestId`), and the exact publication scope (chain ID,
IdentityRegistry address, and agent ID). Duplicate source identities are rejected. The journal
persists a canonical digest of the sanitized pending drafts, non-secret redaction receipts,
source identities, polarity, and instance IDs; changed inputs under the same identities fail
closed. It freezes one `createdAt`, records uploaded member facts incrementally, then stores the
exact canonical partition plan. A journal key may only ever refer to that frozen scope, source
order, member digest, and plan; a mismatch fails closed.
Direct callers that do not supply stable identities retain in-process behavior but cannot opt
into durable recovery accidentally.

Each partition advances through prepared, broadcast, and confirmed states. The transaction hash
is journaled through an `onBroadcast` callback immediately after the EOA send returns, before
nonce-ledger bookkeeping or receipt waiting starts. Any failure after a successful send retains
the exact hash and is non-retryable. On resume, confirmed partitions skip chain publication; broadcast
partitions reconcile their stored transaction receipt before any new transaction is allowed.
A reverted receipt returns the partition to prepared; an unavailable or pending receipt remains
uncertain and fails closed. Anchor telemetry and contribution-ledger finalization are idempotent,
so recovery can repeat local finalization without duplicate rows. Every local-finalization error
retains the batch key and exact member references, and the bridge propagates that recovery identity
alongside the irreversible anchor facts.

Member uploads are journaled after each successful envelope upload. Member, partition, manifest
upload, strict CID-validation, and anchor failures therefore return typed recovery errors
containing every durable member reference collected so far and the batch key, including
single-partition batches. The exact frozen plan lets later invocations resume without rebuilding
time-dependent signed envelopes or changing manifest CIDs. Every journal write after a member
upload is inside typed recovery handling; a failed frozen-plan write therefore reports the uploaded
references and batch key, and a retry resumes those uploads instead of repeating them.

## CID validation

The manifest CID parser consumes the complete multibase payload, rejects non-minimal varints and
non-canonical base16/base32 encodings, and then enforces CIDv1, raw codec, a 32-byte sha2-256
multihash, and equality with the exact canonical body digest. The publish path must reject every
malformed CID before invoking the anchor dependency.

## Migration and compatibility

The journal is an additive `CREATE TABLE IF NOT EXISTS` migration. Existing databases and
per-record publication are unchanged. Existing manifest anchor rows remain readable. Journaling
is wired only for live manifest mode; test and local-only dependencies perform no live writes.
Production batching always uses the fixed 262,144-byte raw-block ceiling; smaller partition
fixtures are created entirely in tests and cannot alter live behavior. The CLI describes the real
behavior as one anchor per raw-block-sized partition.

## Verification

Regression tests cover malformed trailing base32, overlong varints, zero pre-anchor calls,
partial-upload facts, frozen-plan collision rejection, confirmed-partition skipping, uncertain
transaction reconciliation, reverted-transaction retry, scope and member-digest conflicts,
nonce-ledger failure after broadcast, single-member preparation recovery facts, and idempotent
anchor/ledger finalization. Frozen-plan journal failure tests also prove exact recovery facts and
no duplicate upload/broadcast on retry. Focused manifest/identity/store/CLI tests, client
typechecks, the full client suite, and `git diff --check` are the completion gates.
