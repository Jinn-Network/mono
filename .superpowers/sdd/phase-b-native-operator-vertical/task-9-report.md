# Task 9 — B7 native evaluator, verdict, and settlement report

## Scope and result

B7 now provides a separate, production-startable native evaluator role that consumes finalized
canonical solution opportunities, authenticates the exact native subject graph before claiming,
derives a deterministic pair-fixed and grant-free evaluation Task/Submission, executes that pair
through `TaskExecutionBackend` and the pinned prediction evaluation harness, publishes the exact
evaluation graph through a persistent evaluator discovery identity, and reconciles marketplace
Deliver plus verdict settlement to canonical finality. The decision-grade named verdict gate runs
over exact bytes immediately before settlement and again against the canonical finalized verdict
observation.

The evaluator role does not start the solver WorkLoop, open another `BaseVenue`, import a bridge
Task/subject, use the rejected capability-grant signer resolver, or load the legacy TaskEngine or
delivery watcher. Explicit legacy mode remains available for B10 compatibility. No Task,
Submission, or Delivery protocol schema and no deployed marketplace contract changed.

Base commit: `bb3ecc1291a82b5ee43df65300f89af9bff04aaf`

Implementation commits:

- `b74ae8382` — isolate evaluator host secrets from requester capability grants
- `436156462` — persist the native evaluator aggregate, operations, artifacts, and outboxes
- `f402a3159` — require effective-time requester/admission/executor/evaluator authority before claim
- `59c4adaaf` — authenticate the exact native subject graph and derive a grant-free evaluation pair
- `724913d99` — reconcile evaluation claim, marketplace Deliver, and verdict chain operations
- `611ed50df` — coordinate claim, backend recovery, exact result collection, and lifecycle resumption
- `b0b9efaea` — verify and re-verify the canonical native verdict settlement graph
- `cf3d89287` — publish exact evaluator records through a dedicated signed source
- `8fa5699b5` — scope evaluator host signing authority to the exact execution context
- `ebec5ba60` — require distinct effective delivery authority for the evaluation Delivery
- `8581e6491` — compose the dedicated native evaluator role with the real harness and prediction adapter

Implementation head before this report: `8581e6491`

## Durable evaluator lifecycle and recovery

The shared native operator database advances additively to schema version 3. It adds evaluator
aggregate, derived-pair, artifact, operation, publication, source-checkpoint, and audit tables while
preserving all B5 claim and B6 solution rows and identities. The evaluator lifecycle persists:

- the finalized source sequence and canonical solution event identity;
- the advertised solution Delivery digest and stable `evaluationId`;
- a verified authority proof over exact subject identities;
- exact sealed evaluation Task and grant-free Submission bytes;
- deterministic evaluation Attempt and DispatchContext bytes;
- stable evaluation-claim, backend-submit, marketplace-Deliver, and verdict-settlement operations;
- exact evaluation evidence, verdict DSSE, evaluation Delivery, and Delivery DSSE bytes; and
- one publication outbox row per evaluator source/role/digest/availability identity.

Opportunity admission is transactional with its durable source checkpoint. Duplicate entries are
no-ops. Only canonical finalized opportunities are admitted. A later signed/canonical retraction
must advance the source sequence and marks the aggregate withdrawn before irreversible work, or
fails closed once an incompatible chain effect exists.

Every external chain action has intent-before-side-effect. Broadcast and replacement hashes remain
attached to one stable logical operation. The coordinator adopts canonical attempt/settlement reads,
waits for finality, and marks pre-finality orphaned effects without minting another logical ID.
`backend.recover(attempt)` always precedes a possible backend submit: matching recovery adopts the
existing execution, absence allows the exact persisted pair to be submitted, and contradictory
recovery fails closed.

Startup ordering is deliberately recovery-first: reconcile every nonterminal evaluator aggregate,
then read the opportunity source. Shutdown drains/closes the backend before closing the evaluator
publisher, so a terminal backend result is not separated from the publication owner during an
orderly stop. The composition owns neither the injected verdict venue ports nor their venue; the
caller remains the single `BaseVenue` lifecycle owner.

## Exact native subject and pair derivation

Before an evaluation claim can be emitted, `verifyNativeSubjectAuthority` parses canonical exact
Task, Submission, solution Delivery, requester envelope, admission receipt, solution Delivery
envelope, EvaluationSpec, outputs, and execution-evidence bytes. It rejects any advertised digest
or graph mismatch and verifies:

- the Submission names the exact Task digest;
- the Task names the exact public EvaluationSpec digest;
- the admission annotation names the exact receipt envelope;
- the requester DSSE payload is byte-identical to the exact Submission and the requester binding is
  valid at sealing time;
- the admission receipt subjects are the exact Task and EvaluationSpec and the admission issuer is
  valid at its effective time;
- the solution Delivery names the exact Task, results, and evidence records;
- the solution Delivery DSSE payload is byte-identical and its executor binding is valid at
  `Delivery.createdAt`;
- solver and evaluator agents and EVM addresses are distinct; and
- the evaluator key/agent/policy chain is valid at the configured evaluation effective time.

The persisted authority proof digest covers all of those exact identities. Evaluation derivation
then produces one pair-fixed `evaluation-task/1.0` Task and Submission from the trusted subject
graph and stable evaluation identity. `capabilityGrants` is exactly empty. The evaluation Task and
Submission published by the evaluator source are the same exact byte arrays passed to the backend;
the integration test compares them byte-for-byte rather than reserializing them.

## Host-owned evaluator signer custody

The launcher contract adds an optional `hostSecretForwards` declaration that is separate from
Submission `capabilityGrants`. The local backend materializes it only through a deployment-owned
`HostSecretResolver` after the launcher plan has been selected and the exact execution context is
known. The authorization tuple covers Attempt, launcher, Task digest, Submission URI and digest,
Task profile, deadline, evaluator agent, signer handle, registration, evaluation method, and target.

Materialization creates a non-symlink `0700` directory and exclusive no-follow `0600` files,
rejects traversal/duplicate declarations, observes cancellation, removes partial material on
failure, and zeroes resolved and copied byte buffers. Secret bytes are never placed in the plan,
Submission, aggregate, publisher, evidence document, logs, or artifact graph.

Native composition pins the evaluator deployment module by exact SHA-256 before import and
recomputes that digest before every secret release. It requires one exact prediction registration,
the trusted evaluator agent, signer handle, real evaluation-method digest, parser allowlist,
resource limits, and real evidence writer. The authorizer then joins the request to the durable
aggregate by exact evaluation Attempt, evaluator, Task, Submission URI/digest, and effective
deadline. Missing or changed deployment facts fail startup or authorization.

`RoleIdentitySet` resolves the persistent `evaluator-verdict` key only when its effective binding
contains both `verdicts` and `deliveries` scopes. It caches a non-exported `KeyObject`, not a
plaintext PEM, and exports a fresh PKCS8 byte array only after each authorized request. This same
distinct role signs the verdict and the native evaluation Delivery; the `evaluator-discovery` key
alone signs evaluator source entries.

## Mandatory consolidated security answers

### 1. Can a requester-controlled grant or record authorize, select, or exfiltrate the evaluator signer?

**No.** The derived evaluator Submission is rejected unless `capabilityGrants` is empty, the
evaluation launcher declares only a host-owned logical signer handle, and the backend's host-secret
path never reads requester grants. Requester-controlled Task/Submission fields cannot select the
evaluator key, registration, module, method, target, or resolver. Those values come from trusted
deployment configuration and persistent evaluator role identity. Tests cover grant-bearing
Submission refusal, absent/wrong host authority, non-leakage, cleanup, and successful authorized
materialization.

### 2. Can signer authority cross the exact Task, evaluation Attempt, launcher, or evaluator binding?

**No within the implemented interface and lifecycle.** A secret request must match the pinned
launcher declaration and deployment module, evaluator agent, role handle, registration and method,
plus the durable aggregate's exact Attempt, Task digest, Submission URI/digest, profile, and
deadline. The effective `evaluator-verdict` binding is re-resolved with required verdict/delivery
scopes; absent, expired, revoked, wrong-agent, wrong-scope, cross-task, cross-Attempt, wrong-launcher,
or post-cancellation requests fail closed. A new byte buffer is exposed only for the authorized
request and is zeroed after exclusive materialization.

### 3. Does settlement bind the exact native graph and canonical verdict code at the relevant times?

**Yes.** Pre-settlement verification reconstructs the gate input from exact retrieved bytes and
ignores producer verification flags. It covers the exact Task, original Submission, requester
envelope, admission receipt, EvaluationSpec, solution Delivery and envelope, result and evidence
sets, pair-fixed evaluation Task, verdict DSSE, evaluation evidence, evaluation Delivery and
envelope. It re-resolves solution executor and evaluation Delivery authority at their respective
Delivery creation times, supplies requester/admission effective times and solver/evaluator chain
declarations to `gateVerdictObservation`, and requires `decisionGrade=true`. After a canonical
finalized verdict observation, the same gate runs again using its block time, evaluator address,
and on-chain verdict code; byte/code/evaluator mismatch fails closed.

## Named verification matrix

| Boundary | Required checks | Failure behavior |
|---|---|---|
| Opportunity | Signed source sequence; canonical finalized event; advertised Delivery digest; non-self evaluator | Refuse admission before operation intent |
| Exact retrieval | Every record hashes to its advertised digest; exact Delivery digest comes from the opportunity, not from self-hashing fetched bytes | Fail closed; no claim |
| Requester | Exact Submission DSSE payload; requester binding and policy at sealing time | Fail closed; no claim |
| Admission | Exact Task/EvaluationSpec receipt subjects; DSSE, issuer binding, policy, witness, and effective time | Fail closed; no claim |
| Solution executor | Exact canonical Delivery and envelope; exact Task/results/evidence graph; executor binding at Delivery creation | Fail closed; no claim/settlement |
| Evaluator | Distinct solver/evaluator agent and address; persistent evaluator binding and policy | Self-evaluation or invalid authority is terminal |
| Evaluation pair | Pair-fixed Task/Submission; stable identity; exact canonical bytes; empty capability grants | Refuse derivation/backend submit |
| Host signer | Exact module digest, launcher, registration, method, evaluator, Attempt, Task, Submission, profile, deadline, handle, target, active scopes | Resolver refuses; no secret file remains |
| Backend | Recover before submit; exact pair and DispatchContext; matching/absent/contradictory classification | Adopt, submit once, or fail closed |
| Evaluation result | One verdict DSSE; exact evidence; canonical evaluation Delivery; output named `verdict` names the exact envelope digest | Refuse publication/settlement |
| Delivery authorities | Exact DSSE payload equality; solution executor and evaluator Delivery bindings at each Delivery time | Refuse settlement |
| Named verdict gate | Exact subject/result/spec/receipt/requester/solver/evaluator/verdict relationships and effective-time policy checks | Require decision-grade; enumerate failed named checks |
| Canonical settlement | Marketplace Deliver precedes verdict claim; stable operation IDs; canonical evaluator/verdict code; block-time gate recheck; finality and block hash | Remain pending, adopt replacement, reopen orphan, or fail closed |

## Publication and public graph

The evaluator owns a distinct signed source named `evaluator-records`, backed by the persistent
`evaluator-discovery` role key and its own root/owner lock. It publishes exact bytes for:

- the derived evaluation Task and Submission;
- evaluation `ExecutionEvidenceDocument` records;
- the verdict DSSE envelope;
- the native evaluation Delivery; and
- the evaluation Delivery DSSE envelope.

Publication is content-addressed and idempotent by durable publication key. Exact blobs and signed
archive/head data are durable before the publication outbox advances. Restart continues from the
persisted source sequence and byte-identical duplicate publications return the existing receipt.
The publisher is exposed by the evaluator composition for the B9/B10 public HTTP host.

## API and data diff

- Added Tier 3 `HostSecretForwardDeclaration`, `HostSecretResolver`, authorization context, and
  backend materialization. This is separate from requester grants and optional for unrelated
  launchers.
- `LaunchPlan` and launcher capabilities may declare host-owned forwards; the evaluation harness
  declares the evaluator signer through that channel.
- Added `NativeEvaluatorStateRepository`, coordinator, publisher, composition, subject-authority,
  pair-derivation, and verdict-verification adapters.
- Native operator schema version increased from 2 to 3 with additive evaluator tables; the real
  on-disk v1 migration test now asserts the exported current schema version and preserves claim rows.
- Hardened verdict ports expose stable transaction identity and canonical attempt/Deliver/verdict
  read models used by the durable coordinator.
- Added evaluation Task and Submission publication roles; publisher bytes are the backend input
  bytes.
- No portable TEP record schema or marketplace contract changed.

## Changed paths

Production:

- `client/src/daemon/native-evaluator-composition.ts`
- `client/src/daemon/native-evaluator-coordinator.ts`
- `client/src/daemon/native-evaluator-publisher.ts`
- `client/src/daemon/native-evaluator-state.ts`
- `client/src/daemon/native-operation-identity.ts`
- `client/src/daemon/native-operator-state.ts`
- `client/src/daemon/role-identities.ts`
- `client/src/evaluator/native-evaluation-derivation.ts`
- `client/src/evaluator/native-subject-authority.ts`
- `client/src/evaluator/native-verdict-verification.ts`
- `client/src/evaluator/opportunities.ts`
- `packages/marketplace/venue-base/src/verdict.ts`
- `packages/task-execution/backend-local/assembly/src/backend.ts`
- `packages/task-execution/backend-local/assembly/src/capabilities.ts`
- `packages/task-execution/backend-local/assembly/src/host-secret-forwards.ts`
- `packages/task-execution/backend-local/assembly/src/index.ts`
- `packages/task-execution/backend-local/launchers/src/contract.ts`
- `packages/task-execution/backend-local/launchers/src/index.ts`
- `packages/task-execution/evaluation-harness/src/launcher.ts`

Tests cover every production path above plus architecture boundaries, deployment/derivation,
opportunity mapping, subject-material resolution, self-evaluation, named-gate delegation, role
identity scope, marketplace binding derivation, and venue verdict ports.

## Verification

All acceptance commands used the repository's pinned Node `v22.23.1`. Package smoke commands used
npm `11.19.0` installed in an isolated prefix, matching the B0 hosted pack-smoke contract.

Green before this report:

- Client serialized architecture, daemon, and evaluator regression — 71 files, 473/473 tests.
- Client TypeScript build check — exit 0.
- Backend-local assembly full suite — 15 files, 108 passed, 1 intentionally skipped; typecheck green.
- Evaluation harness full suite — 5 files, 44/44 tests; typecheck green.
- Evaluator adapters full suite — 10 files, 107/107 tests; typecheck green.
- Marketplace binding full suite — 32 files, 251/251 tests; typecheck green.
- Marketplace venue-base full suite — 22 files, 186/186 tests; typecheck green.
- Serialized pack smokes for backend-local assembly, evaluation harness, evaluator adapters,
  marketplace binding, and marketplace venue-base — all installed their packed closure and verified
  root imports/assets/dependency boundaries under Node `22.23.1` and npm `11.19.0`.

The first broad client run found one stale B6 migration assertion that hard-coded schema version 2
after the additive B7 version-3 migration. The test now asserts the exported current schema version;
an isolated real on-disk v1 migration rerun passes 5/5 tests. The architecture, daemon, and evaluator
suite was then rerun with one worker to avoid the repository's known shared fixed-port collision and
passed 473/473 tests without a fixed-port or environment-only failure.

Failure coverage includes non-final/canonical opportunity refusal, duplicate/retraction handling,
wrong advertised Delivery digest, every subject-graph mismatch, invalid requester/admission/
executor/evaluator authority, self evaluation, grant-bearing pair refusal, host-secret wrong scope
and cleanup, backend absent/matching/contradictory recovery, malformed verdict/evaluation graph,
pre-settlement gate refusal, replacement, already-settled adoption, canonical mismatch, pre-finality
orphaning, finality recheck, restart ordering, exact publication, and owner contention.

## Residual risks and next-task handoff

- There is a known B8 crash window in both native publishers: archive blobs/entry/page/head are
  durable before `source-state.json`. A crash between head advancement and source-state save can
  leave the archive ahead of local publisher state. Clean restart/idempotency is green, but B8 must
  add an append journal or open-time reconciliation plus a fault injected exactly at that boundary.
  B7 does not claim publisher crash safety for that window.
- B8 must run the complete evaluator failure matrix on Anvil: uncertain wallet invocation,
  replacement, one/multi-block reorg, six restart checkpoints, bounded dependency outages, and two
  process contention. The durable state/reconciliation ports exist; full fault equivalence is not
  claimed here.
- The deployment module is local and digest-pinned, and its digest is rechecked before each secret
  release. B9 must also prove its package and module provenance from the clean tarball installation.
- B9 must host the evaluator source publicly and prove the separate consumer's exact graph without
  producer-state access. Package pack smokes are green, but whole-product tarball acceptance is not
  a B7 claim.
- B10 must wire CLI/config role selection and the sole shared venue into the product entry, keep
  explicit legacy mode startable, and collect hosted plus capped Base Sepolia closure evidence.
- No live transaction was submitted in B7. All verdict writes and canonical reads used deterministic
  adapters/tests; fork and live closure remain B8/B10.
