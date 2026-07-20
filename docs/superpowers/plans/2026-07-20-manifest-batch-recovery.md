# Manifest Batch Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make manifest CID validation canonical and split-manifest publication durably resumable without duplicate chain or local records.

**Architecture:** A SQLite JSON journal is keyed by publication scope plus the ordered immutable bridge request IDs and freezes a digest of the sanitized pending members, creation time, exact partition bodies, and transaction states. Publication records each broadcast before nonce-ledger bookkeeping or receipt waiting, reconciles uncertain receipts on resume, skips confirmed partitions, and finalizes anchor and ledger records idempotently.

**Tech Stack:** TypeScript, Vitest, viem, better-sqlite3, canonical JSON, Node crypto.

## Global Constraints

- All production edits use `apply_patch`.
- Manifest bodies remain at or below 262,144 exact canonical UTF-8 bytes.
- No chain call occurs until the returned CID is a canonical CIDv1 raw sha2-256 address of the exact body.
- Existing databases migrate additively; per-record and local-only behavior remain compatible.
- Live manifest retries fail closed on unresolved transaction receipts.

---

### Task 1: Strict canonical CID parsing

**Files:**
- Modify: `client/packages/harness-layer/src/ipfs-cid.ts`
- Modify: `client/packages/harness-layer/test/ipfs-cid.test.ts`
- Modify: `client/packages/harness-layer/test/publish-manifest-batch.test.ts`

**Interfaces:**
- Consumes: `assertRawSha256CidMatches(cid, bodyBytes)`.
- Produces: the same public function with strict full-consumption, minimal-varint, and canonical multibase checks.

- [ ] Add failing tests for an appended base32 character, non-zero discarded base32 bits, non-minimal version/codec varints, and zero `anchorManifest` calls for malformed upload responses.
- [ ] Run the focused CID/publisher tests and confirm the new assertions fail because malformed values are accepted.
- [ ] Implement strict decoding: reject incomplete or non-minimal varints, require exact CID byte length, and re-encode base16/base32 bytes to the supplied canonical representation.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Durable journal and idempotent persistence

**Files:**
- Modify: `client/src/store/store.ts`
- Modify: `client/test/store/erc8004-anchors.test.ts`
- Modify: `client/packages/harness-layer/src/consume.ts`
- Modify: `client/packages/harness-layer/src/publish-live.ts`

**Interfaces:**
- Produces: `loadManifestBatchJournal(batchKey): string | null` and `saveManifestBatchJournal(batchKey, stateJson): void`.
- Produces: idempotent `saveErc8004Anchor` keyed by chain, registry, metadata key, and transaction hash.
- Produces: a live `ManifestRecoveryStore` adapter; local-only and test paths need no journal.

- [ ] Add failing store tests for journal round-trip/replacement, additive migration, and duplicate-anchor suppression.
- [ ] Run the store tests and confirm missing journal methods and duplicate rows fail.
- [ ] Add the journal table and unique anchor index migration, deduplicating exact legacy anchor rows before index creation.
- [ ] Implement journal load/save and conflict-safe anchor insertion.
- [ ] Run the store tests and confirm they pass.

### Task 3: Broadcast callbacks and receipt reconciliation

**Files:**
- Modify: `client/src/captures/publish.ts`
- Modify: `client/src/erc8004/identity.ts`
- Modify: `client/test/erc8004/identity-manifest.test.ts`
- Modify: `client/packages/harness-layer/src/publish-live.ts`

**Interfaces:**
- Produces: optional non-retryable `onBroadcast(txHash)` immediately after the wallet send and before awaited nonce-ledger bookkeeping on manifest and receipt-bound control publication.
- Produces: `IdentityPublisher.reconcileTransaction(txHash)` returning confirmed telemetry, reverted, or pending.
- Produces: live `reconcileAnchor(txHash)` dependency used by the journal resume path.

- [ ] Add failing tests that `onBroadcast` runs after send and before receipt wait and that reconciliation distinguishes success, revert, and missing receipt.
- [ ] Run identity tests and confirm the new behavior is absent.
- [ ] Thread the callback through `_writeMetadata`, `publishManifest`, and `publishContentV2`; add read-only receipt reconciliation.
- [ ] Wire the live publisher callback and reconciliation adapter.
- [ ] Run identity tests and confirm they pass.

### Task 4: Journaled member upload, partition resume, and idempotent finalization

**Files:**
- Modify: `client/packages/harness-layer/src/publish.ts`
- Modify: `client/packages/harness-layer/src/bridge.ts`
- Modify: `client/packages/harness-layer/test/publish-manifest-batch.test.ts`
- Modify: `client/packages/harness-layer/test/bridge-manifest.test.ts`

**Interfaces:**
- Adds: stable, unique `sourceId` to manifest member inputs; the bridge supplies `AttemptRef.requestId`.
- Adds: live chain/registry/agent publication scope and a canonical sanitized-member digest to the recovery identity.
- Adds: `ManifestBatchRecoveryError` with durable partial `memberRefs`.
- Consumes: journal load/save, broadcast callbacks, and `reconcileAnchor`.
- Produces: frozen plan resumption that skips confirmed partitions and uses read-before-append `(envelopeRef, anchorTx)` ledger identity.

- [ ] Add failing tests for partial upload facts, single-partition manifest preparation facts, scope/member-digest and plan collision rejection, confirmed-partition skipping, pending receipt fail-closed behavior, reverted receipt retry, and crash-safe anchor/ledger finalization.
- [ ] Run focused publisher/bridge tests and verify each new test fails for the intended missing behavior.
- [ ] Implement stable batch-key derivation and journal serialization, freezing all original pending inputs before the first upload.
- [ ] Journal every member upload and exact partition body, recording manifest/control broadcasts at callback time.
- [ ] Reconcile broadcast states before retry, skip confirmed transactions, and finalize telemetry/ledger rows idempotently.
- [ ] Run focused publisher/bridge tests and confirm they pass.

### Task 5: Operator truth and verification

**Files:**
- Modify: `client/packages/harness-layer/src/cli.ts`
- Modify: `client/packages/harness-layer/test/cli.test.ts`
- Modify: `docs/superpowers/notes/1829-manifest-anchor-design.md`
- Modify: `docs/superpowers/notes/1829-manifest-anchor-plan.md`

**Interfaces:**
- Produces: operator language stating one anchor per raw-block-sized manifest partition and automatic journal resume/reconciliation.

- [ ] Add a failing CLI assertion rejecting the old “bridge batch once” promise.
- [ ] Update CLI and runbook language to describe partitioned anchors and fail-closed reconciliation.
- [ ] Run focused manifest, identity, store, bridge, and CLI suites.
- [ ] Run client/core typechecks and tests, `git diff --check`, and confirm the exact branch/base identities.
- [ ] Commit the implementation and force-with-lease push the draft PR branch.
