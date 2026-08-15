# Task 10 — B8 crash, duplicate, contention, and reorg recovery report

## Scope and result

B8 hardens the B3–B7 native requester, solver, publisher, and evaluator seams rather than adding a
second lifecycle. Requester wallet-return uncertainty, claim uncertainty, backend/evidence
interruption, signed-source partial append, evaluator dependency interruption, transaction
replacement/orphaning, safe-chain correction, finalized contradiction, duplicate input, and
two-process worker contention now converge through the existing durable repositories and
coordinators.

The checked-in recovery matrix executes eight deterministic seeds from a machine-readable
manifest. For every restart-capable seed, it runs an uninterrupted oracle and an on-disk restart
variant, then compares the final canonical graph root, stable logical operation IDs, final state,
logical external effects, and bounded invocation counts. The matrix uses the production requester,
claim/solution/evaluator coordinators, state repositories, signed-source append machinery,
projector reorg-correction helper, and SQLite worker lease. It does not substitute a test-only
state machine.

Base commit: `af6bc28491580fd398d6a1273a56695fcaf09f20`

Implementation commits:

- `59b3175a8` — recover shared signed-source appends and enforce source ownership
- `3d4cfdeed` — bound and persist native solution retries
- `24bcd0e2a` — bound and persist native evaluator retries and v1/v2/v3 migration
- `f3a7d2087` — cover requester wallet-return uncertainty through the production requester
- `33d30c62b` — execute the seeded matrix and reopen proven-orphaned evaluator operations

Implementation head before this report: `33d30c62b86b30a3df86e6385ee4ed28a2370c4d`

No live RPC, wallet, IPFS, or Base Sepolia transaction was used in B8. Chain facts are deterministic
canonical/replacement/orphan fixtures supplied through the production reconciliation ports.

## Production recovery changes

### Signed source append and ownership

The solution and evaluator publishers now share `native-signed-source.ts`. A durable append journal
records the exact source, sequence, prior entry, next entry, page, head, record bytes, and expected
publication receipt before page/head mutation. Recovery verifies real Ed25519 DSSE entry/head
signatures, exact content digests, source identity, page/entry/head continuity, and any existing
state receipt before it completes or adopts an append. The source sequence is never reused and old
pages are never rewritten.

The source owner record binds source identity, signing key, PID, random owner token, and expiry.
Takeover requires the same source/key, expired ownership, and a dead PID; an expired but live owner
is refused. Quarantine is atomic and close removes ownership only when the random token still
matches. Version-1 publisher state is migrated only after the signed archive verifies.

### Durable bounded retries

The additive operator schema is version 4. `native_solution_retries` and
`native_evaluation_retries` persist resume state, reason, retry count, next-at, deadline, and update
time. Versions 1, 2, and 3 migrate table-driven to v4 while preserving solver and evaluator rows.
A legacy v3 paused evaluator row reconstructs its resume stage from durable operations/artifacts
and its deadline from the exact sealed evaluation Submission; contradictory bytes fail closed.

Only wrapped external dependency failures are retryable. Unknown internal errors, type/state
conflicts, digest contradictions, backend contradictions, and finalized correspondence conflicts
are terminal. Both coordinators reconcile canonical absence before any wallet-uncertain rebroadcast,
enforce next-at/deadline/attempt budgets, and call backend recovery before possible resubmission.

### Evaluator orphan recovery

The seeded verdict scenario exposed a real B7 gap: evaluator operations could be marked orphaned,
but `createOperation` never reopened them. The state repository now reopens only a proven-orphaned
operation with the same stable operation ID and byte-identical identity detail. It retains the prior
transaction hash, clears the orphaned transaction/block facts, returns to `intent`, and appends an
audit event. Changed operation detail is rejected. Finalized operations are returned unchanged and
can never be reset by the reopen path. Orphaning retains the immutable operation identity detail;
the reorg reason remains in the audit trail rather than overwriting the operation input.

## Seeded recovery evidence

The authoritative expected results are in
`client/test/fixtures/native-recovery-matrix.v1.json`. Each result carries a `sha256:` graph root;
restart seeds assert the recovered root exactly equals their uninterrupted oracle. Hash values are
intentionally not fixture-pinned because each test run generates isolated Ed25519 fixture
identities; the equality, shape, and graph inputs are asserted in-process.

| Seed | Injected boundary and durable before/after snapshot | Final state | Stable operations | Measured invocations | Canonical effects |
|---|---|---:|---:|---|---|
| B800 | Posting intent persisted; wallet invoked but return lost; requester reopened same state directory and recovered canonical `TaskCreated` before any post retry | `published` | 1 posting identity | post 1, recover 1 | 1 posting, 1 signed requester entry |
| B801 | Eligible engagement/claim intent; claim wallet return lost after canonical attempt existed; Store reopened and startup reconciliation adopted it | `claim-finalized` | 1 claim | claim 1 | 1 canonical claim |
| B802 | Finalized claim submitted once; first evidence read unavailable; persisted `paused` row reopened and resumed after next-at | `solution-settled` | 3: claim, backend submit, solution settlement | backend recover 2, submit 1, evidence read 2, publish 4, settle 1 | 1 backend execution, 4 exact public records, 1 settlement |
| B803 | Exact record and append journal durable; page/head committed; fault before publication-state receipt; publisher reopened from disk | `published` | 1 publication key | publish API 2 | 1 signed archive entry and one sequence; no rewritten page |
| B804 | Finalized evaluation claim; backend recovery dependency unavailable; evaluator persisted pause, reopened Store, and resumed | `evaluating` | 2: evaluation claim, backend submit | backend recover 2, submit 1 | 1 evaluator backend submission |
| B805 | Valid persisted `verdict-published` graph; Deliver and verdict claim each pass broadcast → replacement → restart → orphan → same-ID reopen/rebroadcast → finality | `complete` | 4: evaluation claim, backend, Deliver, verdict settlement | status read 4, Deliver wallet 2, verdict wallet 2 | 2 replacements, 2 orphan corrections, 1 canonical Deliver, 1 canonical verdict settlement |
| B806 | Consumer projection withdrew/reopened a safe-chain replacement; signed source appended a real Ed25519 withdrawal; attempted finalized solution reversal | `evaluation-pending/solution-settled` | 3 solver operations retained | B802 counts plus consumer retraction 1, replacement admission 1, signatures 3 | page 1 unchanged, one page-2 withdrawal, zero readback replay additions, finalized settlement preserved |
| B807 | One child process acquired the real SQLite scoped worker lease; parent process attempted the same role before any discovery work | `one-worker` | 0 loser operations | 2 processes | 1 active worker, 0 loser discovery rows, 0 loser operations |

B805 performs two wallet invocations per rail by design: the first transaction is proven orphaned
before the second invocation. These are two transaction attempts under one logical operation ID,
not duplicate logical Deliver or settlement effects.

## Signed correction and reorg proof

B806 uses `appendSignedReorgCorrections` with the production on-disk filesystem blob store and one
persistent Ed25519 identity shared by the oracle/restart variants. The prior availability entry is
itself signed by that real identity. The test then verifies:

- archive page 1 is byte-identical before and after correction;
- page 2 contains exactly one `withdrawn` action naming the prior availability;
- the page-2 DSSE payload equals the exact sealed correction entry and its signature verifies;
- the correction entry sequence and `previous` digest immediately extend page 1;
- the signed head payload/signature verifies and names the correction entry digest;
- a freshly opened filesystem reader recovers page 2/head and replay adds no page or entry; and
- the consumer checkpoint advances through withdrawal and canonical replacement without rewriting
  its prior subject bytes.

The solution half separately proves that `recordSolutionSettlementOrphaned` refuses a finalized
settlement. The operation remains `finalized`, the engagement remains `solution-settled`, and the
immutable artifact graph root is unchanged. Finalized-chain contradiction is therefore fail-stop,
not scheduled retry.

## Failure and duplicate coverage outside the matrix

Focused publisher/coordinator suites additionally cover all five signed append boundaries:

1. record persisted before journal;
2. journal persisted before archive page;
3. page persisted before head;
4. head persisted before publication state;
5. publication state persisted before journal cleanup.

They also cover duplicate exact publication, tampered journal/page/head/record bytes, wrong source
or key, stale-dead takeover, live-but-expired refusal, token-safe close, matching/absent/
contradictory backend recovery, evidence/publication/settlement outages, retry budget/deadline,
transaction absence before rebroadcast, transaction replacement, pre-finality orphaning, changed
operation identity, terminal internal/state errors, and finalized contradictions.

Requester recovery calls the real `createNativeRequester` posting draft/reconcile path. B807 uses a
separate `tsx` child process importing the production Store and state repository, not merely two
objects over one connection. The losing process is refused before discovery or transaction work.

## API and data diff

- Added the shared internal signed-source append/recovery owner used by both native publishers.
- `NativeRoleIdentity` can verify signatures with its persistent public Ed25519 key.
- Added durable solution/evaluator retry rows and `paused` state handling; schema version is 4.
- Added retry configuration and startup resume behavior to the existing solution/evaluator
  coordinators; no portable Task Execution Protocol or marketplace API changed.
- Hardened evaluator operation creation to reopen only same-ID/same-input orphaned operations.
- Added the machine-readable recovery manifest and separate-process lease fixture.
- No destructive legacy migration, marketplace contract change, or new state architecture.

## Changed paths

Production:

- `client/src/daemon/native-signed-source.ts`
- `client/src/daemon/native-solution-publisher.ts`
- `client/src/daemon/native-evaluator-publisher.ts`
- `client/src/daemon/native-solution-coordinator.ts`
- `client/src/daemon/native-evaluator-coordinator.ts`
- `client/src/daemon/native-operator-state.ts`
- `client/src/daemon/native-evaluator-state.ts`
- `client/src/daemon/role-identities.ts`

Tests and fixtures:

- native requester, role identity, operator/solution/evaluator state and coordinator tests;
- native solution/evaluator publisher tests;
- `client/test/daemon/native-recovery-matrix.test.ts`;
- `client/test/fixtures/native-recovery-matrix.v1.json`; and
- `client/test/fixtures/native-worker-lease-holder.ts`.

## Verification

All acceptance commands used the repository's pinned Node `v22.23.1`.

Fresh green evidence:

- Focused B8 recovery set — 11 files, 93/93 tests.
- Evaluator state/coordinator/matrix regression after orphan hardening — 3 files, 13/13 tests.
- Requester suite including wallet-return recovery — 7/7 tests.
- Client TypeScript build/typecheck — exit 0.
- Full client daemon domain, serialized to respect fixed test ports — 58 files, 458/458 tests,
  exit 0.
- `git diff --check` — clean.

The first broad daemon invocation used Vitest's default file parallelism. It passed 450/458 tests
but eight daemon/event-loop tests collided on fixed port 7331 with `EADDRINUSE`. The exact two files
then passed 9/9 with one worker, and the entire 58-file daemon domain was rerun with
`--maxWorkers=1 --fileParallelism=false` and completed with exit 0. No source change was made to
mask that harness-level collision.

Commands:

```text
PATH="/Users/adrianobradley/.hermes/node/bin:$PATH" yarn --cwd client vitest run \
  test/daemon/native-evaluator-coordinator.test.ts \
  test/daemon/native-evaluator-publisher.test.ts \
  test/daemon/native-evaluator-state.test.ts \
  test/daemon/native-operator-state.test.ts \
  test/daemon/native-recovery-matrix.test.ts \
  test/daemon/native-solution-coordinator.test.ts \
  test/daemon/native-solution-publisher.test.ts \
  test/daemon/native-solution-state.test.ts \
  test/daemon/projector-cursor.test.ts \
  test/daemon/projector-loop.test.ts \
  test/native-requester/requester.test.ts --reporter=dot

PATH="/Users/adrianobradley/.hermes/node/bin:$PATH" yarn --cwd client typecheck

PATH="/Users/adrianobradley/.hermes/node/bin:$PATH" yarn --cwd client vitest run \
  test/daemon --maxWorkers=1 --fileParallelism=false --reporter=dot

git diff --check
```

## Remaining risk and handoff

B8 proves deterministic local/fork-style recovery through production seams; it does not claim a
live public testnet reorg or transaction replacement. B9 still owns clean catalog-tarball product
and independent-consumer proof. B10 still owns hosted exact-head closure and one capped live Base
Sepolia run.

The recovery matrix intentionally uses isolated temporary state roots and test identities. It
proves persistence within each oracle/restart pair and exact signed-history recovery, while B2's
separate production identity tests remain the authority for encrypted long-lived role custody and
effective-time bindings.
