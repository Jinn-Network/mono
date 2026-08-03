# Task 8 — B6 native solution execution and settlement report

## Scope and result

B6 now carries a finalized native solver claim through the public
`TaskExecutionBackend`, exact execution/evidence/output retrieval, delivery-time trust
verification, a distinct signed `solver-records` source, and canonical finalized solution
settlement. The native WorkLoop resumes every nonterminal solution aggregate at startup and
immediately hands a newly finalized claim to the solution coordinator. The explicit legacy path
remains startable and unchanged; native code does not call its Task/Submission or Delivery
bridges.

Base commit: `9cf540cf40e66726b9374fb60231006c3599b83e`

Implementation commits:

- `27c74fa4e` — retrieve digest-only backend outputs from the durable harvest journal
- `2e7eeb918` — persist exact native solution inputs, artifacts, publications and settlement
- `93c4dadcc` — coordinate backend recovery, exact evidence/output retrieval and settlement
- `287616551` — publish exact solution records through the dedicated signed source
- `71578a973` — verify the exact solution graph and delivery-time executor authority
- `a221adedd` — expose settlement operation and transaction identity from marketplace ports
- `dddfb4c88` — reconcile settlement only from canonical projector/finality facts
- `de12826ad` — reopen orphaned settlement under the same logical operation identity
- `628045614` — wire production composition and WorkLoop startup/resumption

Implementation head before this report:
`62804561462b7b59d50e2a119e250e98e5210612`

## Exact execution and recovery

`NativeOperatorStateRepository` advances additively from schema version 1 to version 2. The new
solution tables retain:

- the original exact Task and Submission bytes and their digests;
- the exact canonical DispatchContext bytes and digest;
- one stable backend-submit operation per engagement/Attempt;
- exact output, `ExecutionEvidenceDocument`, Delivery and Delivery-envelope bytes;
- one publication outbox row per source/role/digest/availability tuple;
- one stable solution-settlement operation per Attempt and Delivery digest.

The DispatchContext is authored and durably written by `beginSolutionExecution` before the first
backend call. It is subsequently read from storage; verification and settlement never reconstruct
it. `backend.recover(attempt)` always precedes `backend.submit`. Matching recovery adopts the
existing attempt without resubmission, absence permits the byte-identical submit, and
contradictory recovery fails closed. Startup reconciliation enumerates `claim-finalized`,
`executing`, `solution-ready`, `solution-published` and `solution-settlement-pending` aggregates.

`LocalTaskExecutionBackend.fetchArtifact` now resolves digest-only Delivery outputs from the
durable `harvested` journal. Retrieval remains contained beneath the attempt root, uses
`O_NOFOLLOW`, and checks the exact expected size and SHA-256 before returning bytes. This removes
the prior false assumption that every output descriptor carries a URI or inline content.

## Evidence and exact graph verification

The coordinator parses only canonical sealed Task, Submission and Delivery bytes. It retrieves
each `Delivery.evidenceRecords` reference from the evidence repository, waits for the actual
reference to be indexed, and verifies that reference's digest. It independently retrieves and
verifies every Delivery output descriptor. Delivery bytes are never hashed and treated as an
execution-evidence identity.

Before publication or settlement, `buildNativeSolutionVerification` verifies:

- exact Task, Submission, DispatchContext and Delivery canonical seals;
- engagement Task/Submission/Attempt/nonce relationships;
- every output name/media type/digest and every evidence family/digest;
- the Task's advertised EvaluationSpec resolves to the exact advertised digest;
- the Delivery DSSE payload type, exact payload bytes, signer key ID and Ed25519 signature;
- the solver operator equals the B2-bound native agent.

`RoleIdentitySet` retains its real `BindingResolver` and re-resolves the `solver-delivery` key at
`Delivery.createdAt`. Key identity, effective start, expiry, required `deliveries` policy scope,
and every effective revocation are checked again. Boot-time success is never cached as authority
for settlement.

## Public solution source and lifecycle ownership

Native composition opens a dedicated `solver-records` discovery source with the persistent
`solver-discovery` role key. It has its own root, append state, signed entries, archive pages,
signed head, well-known record and exact-record HTTP handler. It does not use the ProjectorLoop's
`operator-projector` source tuple or archive root.

Publication is content-addressed and idempotent by the durable publication key. Record blobs and
the signed entry/page/head are durable before the product outbox is marked published. Restart
continues at the next source sequence. A process-local filesystem owner record prevents a second
publisher lifecycle from opening the same source root; the duplicate-owner test proves the
refusal. The publisher is exposed on `OperatorComposition` for the B9/B10 public HTTP host and is
closed before the evidence and venue owners.

## Settlement and canonical finality

The today-generation native settlement adapter uses the sole composed `BaseVenue` and its sole
Safe broadcaster. It:

1. submits the Mech Deliver leg idempotently;
2. checks the Mech raw-CID SHA-256 fact against the exact Delivery bytes;
3. pins the exact Delivery;
4. calls `claimSolutionDelivery` with the stable product operation ID and today-mode keccak
   digest;
5. retains the mined settlement transaction identity;
6. verifies the router fact binds the same request and keccak digest.

`SettlementPorts.claimSolutionDelivery` additively accepts an optional operation ID for legacy
compatibility; native composition always supplies it. The venue uses it as its broadcaster
logical transaction identity and returns the mined transaction hash. Already-settled recovery
resolves the corresponding on-chain transaction instead of fabricating one.

A receipt records broadcast identity only. Finality advances solely when the same
`ProjectorCursorStore` used by the composed ProjectorLoop contains an exact
`delivery-recorded.v1` observation for the Attempt and Delivery digest, the observation block is
at or below the projector's finalized checkpoint, and a canonical block-hash read still matches.
A safe/non-finalized observation remains pending. Replacement adopts the canonical observation's
transaction under the same operation. An append-only reorg correction or canonical hash mismatch
marks the operation orphaned, returns the engagement to `solution-published`, and the next
reconciliation reopens the same `solutionSettlementId`; no second logical operation is created.

## Composition and WorkLoop ordering

Native composition now requires solution runtime configuration alongside B5 claim state:

- a dedicated publisher root and public base URL;
- an exact Task/Submission resolver by durable engagement;
- an exact EvaluationSpec resolver.

It constructs the real publisher, verifier, coordinator, evidence repository adapter and
today-mode settlement adapter. The settlement reader consumes the single projector owner's
observation stream, finalized cursor and canonical hash reader. No second venue, projector store,
evidence runtime or publisher owner is opened.

Native WorkLoop startup ordering is now:

1. acquire the B5 solver lease;
2. reconcile claim operations;
3. reconcile every nonterminal solution execution/publication/settlement;
4. synchronize the verified discovery source;
5. begin polling.

A newly returned `claim-finalized` result is handed directly to
`NativeSolutionCoordinator.reconcileEngagement`. Idle and active ticks continue to renew the same
claim/solution worker ownership before source synchronization.

## API and data diff

- Native operator schema version increased from 1 to 2 with additive solution execution and
  artifact tables; existing claim rows retain their identities and state.
- Added `NativeSolutionCoordinator`, verification, publisher and settlement adapters.
- Added native solution runtime/coordinator/publisher fields to `OperatorComposition` and
  `WorkLoopConfig`.
- `RoleIdentitySet` additively exposes delivery-time `resolveEffective` decisions.
- Marketplace `SettlementPorts.claimSolutionDelivery` additively accepts `operationId` and may
  return `txHash`; existing callers remain source compatible.
- Backend `fetchArtifact` behavior now covers exact digest-only locally harvested outputs.
- No TEP record schema or deployed marketplace contract changed.

## Changed paths

Production:

- `client/src/daemon/composition-root.ts`
- `client/src/daemon/native-operation-identity.ts`
- `client/src/daemon/native-operator-state.ts`
- `client/src/daemon/native-solution-coordinator.ts`
- `client/src/daemon/native-solution-publisher.ts`
- `client/src/daemon/native-solution-settlement.ts`
- `client/src/daemon/native-solution-verification.ts`
- `client/src/daemon/role-identities.ts`
- `client/src/daemon/work-loop.ts`
- `packages/marketplace/binding/src/settlement.ts`
- `packages/marketplace/venue-base/src/writers/settlement.ts`
- `packages/task-execution/backend-local/assembly/src/backend.ts`

Tests:

- `client/test/architecture/native-solution-boundaries.test.ts`
- composition, daemon, WorkLoop, role-identity and native operation/state tests
- native solution coordinator, publisher, settlement and verification tests
- marketplace venue settlement writer tests
- backend artifact retrieval tests

## Verification

All commands used Node `v22.23.1`.

Green:

- Client focused B6 integration/architecture selection — 11 files, 89/89 tests.
- Client full daemon and architecture suites, serialized to avoid the repository's shared fixed
  test-port collision — 59 files, 429/429 tests.
- Client TypeScript build check — exit 0.
- Marketplace binding full suite — 32 files, 251/251 tests; typecheck green.
- Marketplace venue-base full suite — 22 files, 185/185 tests; typecheck green.
- Backend-local assembly full suite — 14 files, 105 passed, 1 intentionally skipped.
- `git diff --check` — green before commits.

The DB migration test is a real on-disk v1→v2 restart test. It creates and closes a SQLite file
with preserved B5 claim rows and v1 metadata/no B6 solution tables, opens a fresh `Store` and
`NativeOperatorStateRepository` against that file, and proves the v2 tables exist while the exact
pre-existing finalized-claim Attempt identity remains unchanged.

Failure coverage includes backend absent/matching/contradictory recovery, exact input conflict,
digest-only output tampering, missing/wrong evidence, Delivery-as-evidence refusal, revoked
delivery-time binding, EvaluationSpec absence, duplicate publication and source ownership,
settlement receipt versus finality, transaction replacement, append-only reorg correction,
same-operation orphan retry, and restart sequence recovery.

## Residual risks and next-task handoff

- `main.ts` remains explicit legacy mode until B10 and therefore does not yet host the exposed
  native publisher handler or supply the native runtime inputs. The production composition path
  is concrete and tested; enabling/serving it remains the B9/B10 cutover task.
- No live transaction was submitted. The Mech/solution settlement path is covered by venue unit
  tests and canonical projector integration tests; Anvil fault drills and the capped Base Sepolia
  run remain B8/B10 acceptance.
- The publisher owner file intentionally fails closed after an unclean process exit. B8 should
  add an authenticated/staleness-safe owner recovery drill rather than deleting that lock
  optimistically.
- Dependency outages during solution reconciliation currently collapse to the coordinator's
  durable failed state unless a lower port has already reconciled the effect. B8 should introduce
  the planned bounded `Paused`/retry classification for RPC, public source and evidence outages;
  contradictory exact bytes, invalid trust and digest conflicts must remain terminal.
- B7 must reuse the same stable identity, exact-byte, publication and canonical-finality patterns
  for evaluation and verdict settlement. It must not reuse the solver Delivery key or authorize
  evaluator signing through requester capability grants.
- Packed external consumption and a separate public consumer remain B9 scope.
