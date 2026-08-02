# Task 7 — B5 durable native claim lifecycle report

## Scope and result

B5 now admits and claims native work through a durable product-owned aggregate instead of the
legacy `EngagementLedger` dedup path. A signed B4 queue row is either deferred without
acknowledgement, durably refused and acknowledged, or atomically converted into one engagement
and one claim intent before any wallet call. Claim broadcast, uncertainty, replacement,
safe-chain observation, finality, orphaning and race loss reconcile under the same stable
operation identity.

The native WorkLoop ends at `claim-finalized`. It does not call the B6 execution/evidence/
settlement pipeline. Explicit legacy mode remains startable and continues to own its old ledger,
archive and execution path.

Base commit: `16aef09ad5a16d9c2b11954a8716bb494299601f`

Implementation commits:

- `1492a62c6` — durable native identities, schema, atomic source admission and leases
- `6fe70f975` — evidence-bearing native capability and Tier 4 policy gate
- `4c7fe4854` — durable claim coordinator and canonical operation reconciliation
- `b1fef6004` — native composition, WorkLoop and startup lifecycle wiring

Implementation head before this report: `b1fef6004f41de551d50c20ea255022da621e33c`

## Durable data and identity model

`NativeOperatorStateRepository` installs schema version 1 additively in the daemon Store. It
does not read, transform or reinterpret `engagement_ledger` rows. The new tables are:

- `native_operator_state_metadata`
- `native_engagements`
- `native_operations`
- `native_publication_outbox`
- `native_audit_events`
- `native_worker_leases`
- `native_source_processing`
- `native_source_deferrals`

The exact B4 provenance key is
`(source_agent, source_name, sequence, entry_digest, announcement_id)`. Admission verifies that
composite against the queued row, fingerprints the exact Task/Submission identities, writes the
decision/engagement/claim operation/audit/source-processing facts, and acknowledges the queue row
in one SQLite transaction. Retryable dependency/capacity/finality deferrals remain
unacknowledged; their retry count is durable and their deferral row is removed transactionally
when a later terminal decision succeeds. Reusing the same card or engagement identity with
different sealed inputs fails closed and is audited.

The JCS/SHA-256 operation builders implement the approved preimages for:

- `engagementId`
- `claimOperationId`
- `solutionSettlementId`
- `evaluationId`
- `verdictSettlementId`
- publication keys

Chain and task numeric values are canonical decimal strings, coordinator addresses are validated
and lower-cased, and unsafe numeric/address inputs are rejected. Marketplace Attempt identity is
derived only with `deriveMarketplaceAttemptUri` after canonical claim facts name an attempt
index. Pinned tests freeze the identity digests.

Aggregate state is distinct from operation state. Claim operations use
`intent → broadcast → observed-safe → finalized`, with explicit `replaced`, `orphaned`, and
`failed-terminal` correction states. Wallet-return uncertainty is stored as broadcast-uncertain
without inventing a transaction hash. Re-broadcast is allowed only after the canonical reader
proves absence, and it reuses the same operation ID. Broadcaster receipt block data is retained
only as diagnostic detail: it cannot advance safe/finalized Attempt facts.

## Capability and Tier 4 policy

`evaluateNativeClaim` verifies the original exact Task and Submission bytes and joins them to the
signed discovery card before policy or capability admission. Native mode fixes legacy cards off
and defaults to the Phase B prediction profile allowlist.

The persisted capability evidence includes:

- the backend capability snapshot;
- selected launcher/deployment identity and executable digest;
- the combined deployment/launcher readiness result;
- backend preflight result.

The claim is refused before an intent when any settlement prerequisite is absent: callable and
advertised preflight, signed Deliveries, evidence capture other than `none`, deadline enforcement,
required output media types, supported requirements, and an `enforced` run-pinning posture for
every effective pin. Backend capability errors, probe outages, preflight failures, capacity and
finality are retryable deferrals. Stable profile, requirements, network, spend and deadline
policy failures are durable terminal refusals.

The deployment probe no longer reports a constant ready value. It verifies executable permission,
re-hashes the executable against its boot digest, invokes the launcher's own probe, and fails
closed when either check is absent, throws, changes, or reports not ready.

## Claim reconciliation and ownership

`NativeClaimCoordinator` owns only admission and the claim operation. It requires a live lease
scoped to `(solver, chainId, coordinator, operatorAgent)` before admission, reconciliation and
every claim broadcast. The WorkLoop renews that lease before each verified-source poll, including
idle ticks. A second coordinator fails before source sync, admission or broadcast.

`operatorAgent` is the explicit agent IRI retained by `RoleIdentitySet` from the B2 effective-time
binding queries. Native composition rejects an absent or mismatched agent; it never synthesizes an
agent from the Safe address. It also rejects a native policy whose network identity differs from
the composed venue.

The claim writer accepts the durable operation ID as its broadcaster logical transaction
identity and returns transaction identity plus receipt diagnostics. Canonical claim reconciliation
supports absence, broadcast, replacement, observed-safe, finalized, orphaned and lost facts.
No receipt is treated as canonical observation authority.

## Composition and startup ordering

Native composition now requires a concrete `NativeClaimRuntimeInput` containing:

- the caller-owned `NativeOperatorStateRepository`;
- the exact Task/Submission byte resolver;
- the canonical claim reader;
- Tier 4 policy/finality/active-count inputs;
- the B2-bound operator agent;
- lease owner and TTL.

It builds the real backend/launcher admission port and composes its one venue claim writer into the
coordinator. Native composition neither constructs nor returns the legacy archive adapter.

After the API port bind mutex, daemon startup performs:

1. acquire the scoped worker lease;
2. reconcile every nonterminal claim operation;
3. sync and verify the signed discovery source head;
4. only then persist `shutdown_state=running` and emit startup-ok;
5. start the polling loops.

A lease/reconciliation/source-trust failure therefore leaves no false running or startup-ok
marker. Native ticks renew ownership before source sync. Queue acknowledgement is exclusively the
coordinator repository transaction; the WorkLoop cannot acknowledge a retryable deferral or a
failed pass independently.

## API and type diff

- Added native operation identity builders and `NativeOperatorStateRepository`.
- Added `NativeClaimCoordinator`, canonical claim fact/reader, admission and broadcast ports.
- Added `NativeClaimRuntimeInput` and native claim fields on `OperatorComposition`.
- Added `NativeLauncherCapabilityPort`, Tier 4 policy and evidence-bearing claim decisions.
- `RoleIdentitySet.agent` now exposes the exact agent used for binding resolution.
- `NativeDiscoveryQueuedCard` now carries its durable `announcementId`.
- Marketplace `ClaimPorts.claimTask` additively accepts `operationId` and may return receipt block
  diagnostics; the venue writer uses the operation ID as `logicalTx`.
- Marketplace pipeline now publicly exports `verifyPreclaim` and
  `validateRequirementsAgainstRunPinning`.
- `OperatorComposition.archive` is compatibility-only and absent in native mode.

No TEP record schema or marketplace contract changed.

## Changed paths

Production:

- `client/src/daemon/native-operation-identity.ts`
- `client/src/daemon/native-operator-state.ts`
- `client/src/daemon/native-claim-policy.ts`
- `client/src/daemon/native-claim-coordinator.ts`
- `client/src/daemon/native-discovery.ts`
- `client/src/daemon/composition-root.ts`
- `client/src/daemon/work-loop.ts`
- `client/src/daemon/daemon.ts`
- `client/src/daemon/role-identities.ts`
- `client/src/store/store.ts`
- `packages/marketplace/binding/src/claim.ts`
- `packages/marketplace/pipeline/src/index.ts`
- `packages/marketplace/venue-base/src/writers/claim.ts`

Tests:

- `client/test/daemon/native-operation-identity.test.ts`
- `client/test/daemon/native-operator-state.test.ts`
- `client/test/daemon/native-worker-lease.test.ts`
- `client/test/daemon/native-claim-policy.test.ts`
- `client/test/daemon/native-claim-coordinator.test.ts`
- `client/test/daemon/composition-root.test.ts`
- `client/test/daemon/work-loop.test.ts`
- `client/test/daemon/daemon.test.ts`
- `client/test/architecture/native-claim-boundaries.test.ts`
- marketplace binding/pipeline/venue writer public-surface and unit tests

## Verification

All verification used Node `v22.23.1` and npm `11.19.0`.

Green:

- Client B5-focused unit/integration/architecture selection — 109/109 before the final
  composition cleanup; final composition/WorkLoop/Daemon/architecture rerun — 55/55.
- `client` full `vitest run --reporter=dot` — exit 0.
- `client` `yarn test` (full prerequisite builds plus Vitest) — exit 0.
- `client` `tsc --noEmit --pretty false` — exit 0.
- Marketplace binding full suite — 32 files, 251 tests; typecheck green.
- Marketplace pipeline full suite — 11 files, 52 tests; typecheck green.
- Marketplace venue-base full suite — 22 files, 185 tests; typecheck green.
- `git diff --check` — green before each commit.

Failure coverage is deterministic rather than seed-randomized. It includes card replay/input
conflict, stable refusal versus retryable deferral, pre-wallet intent, wallet-return uncertainty,
hash persistence, replacement, canonical safe/finality, orphan/retry, race loss, two-process
lease contention, idle renewal, startup lease refusal, missing/changed executable, every
settlement-readiness capability negative, and every Tier 4 policy negative. Tests inspect the
operation/engagement/source rows before and after each boundary and assert one engagement and one
logical claim operation.

## Residual risks and next-task handoff

- The production canonical claim reader is intentionally injected and is not fabricated in B5.
  `main.ts` remains explicit legacy mode until B10, so it does not yet supply this native input.
  Before enabling native mode, B6/B10 must provide a projector/venue adapter backed by the single
  `ProjectorCursorStore.readObservations()` / `BaseVenue` observation stream. It must correlate
  `TaskAttemptCreated`/`attempt-engaged` facts to the stable operation's task and bound operator,
  expose transaction replacement/canonical block/finality, translate B4 retractions into
  `orphaned`, and report task closure/race loss. It must never derive safe/finalized state from the
  broadcaster receipt.
- B5 creates publication/outbox storage but deliberately does not drive B6 execution, evidence,
  Delivery publication or solution settlement operations.
- Lease release is expiry-based; ownership is renewed before every native poll and external claim
  write. A later operational cleanup may add an explicit graceful release, but correctness does
  not depend on it.
- The final hosted/packed/native-product acceptance remains B9/B10 scope. This task verified the
  changed package suites and the full workspace-linked client suite.
