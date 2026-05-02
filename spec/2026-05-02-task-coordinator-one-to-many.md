# TaskCoordinator one-to-many Task lifecycle

- **Date:** 2026-05-02
- **Author:** Codex design session with ritsukai
- **Status:** Proposal
- **Version:** 0.1
- **Primary bead:** `jinn-mono-kod`
- **Unblocks:** `jinn-mono-l2zl.3`, `jinn-mono-l2zl.4`
- **Related:** `docs/superpowers/plans/2026-05-02-prediction-solvernet-v1-task-lifecycle.md`, `spec/2026-05-01-harness-pack-architecture.md`

## 1. Purpose

Prediction SolverNet v1 needs several operators to complete the same posted Task. Each operator should submit one Solution, each valid Solution should receive a Verdict, and all Solutions should be scored against the same immutable Task payload.

The current request path is single-claimer and single-delivery shaped. This spec defines the new generic Task coordination primitive required for one-to-many Tasks without making the operator experience or public vocabulary confusing.

This is a contract and adapter boundary spec. It does not implement code.

## 2. Decision summary

Jinn should introduce an upgradeable `TaskCoordinator` as the canonical lifecycle contract for shared Tasks.

Public/operator model:

```text
Task -> claim Task -> submit Solution -> receive Verdict
```

Internal model:

```text
TaskCoordinator round -> many attempts -> one OLAS Mech requestId per attempt
```

Contract boundary:

```text
TaskCoordinator
  Canonical shared Task lifecycle state:
  Task, claim leases, attempts, requestId mappings, submission state.

JinnRouter
  OLAS Mech integration and current activity-counting bridge:
  marketplace request creation, delivery verification, staking-compatible counters.

Mech Marketplace
  External single-request, single-delivery rail.

ClaimRegistry
  Legacy single-request path. Not the shared Task coordinator.

ActivityLedger
  Deferred. The v1 boundary leaves room to extract generic activity accounting later.
```

## 3. Why not stretch ClaimRegistry

The existing `ClaimRegistry` was designed to coordinate one active claim per marketplace `requestId` with a swappable eligibility checker:

```text
requestId -> one active claimer, with TTL
```

The one-to-many lifecycle changes the coordination unit:

```text
Task -> many operators -> many submissions -> many verdicts
```

A policy checker can answer whether an operator is eligible, but it cannot be the canonical owner of attempt allocation, per-Task participation limits, request registration, delivery state, and future lifecycle transitions. Reusing `ClaimRegistry` for shared Tasks would duplicate state across `ClaimRegistry`, `TaskCoordinator`, `JinnRouter`, and the Mech Marketplace.

Therefore:

- `ClaimRegistry` remains valid for legacy/single-request coordination.
- Shared Tasks use `TaskCoordinator` for claim leases and attempts.
- Optional policy hooks may be used by `TaskCoordinator`, but hooks do not own lifecycle state.

## 4. User-facing naming boundary

Operators should not need to understand internal round and attempt vocabulary.

Use these terms in public CLI/API/docs:

- `Task`
- `claim Task`
- `submit Solution`
- `Verdict`
- `submission`
- `score`

Keep these terms internal/debug/indexer-facing:

- `round`
- `attempt`
- `requestId`
- `attemptIndex`
- `roundId`

Example public flow:

```text
jinn tasks list
jinn tasks claim <taskId>
jinn tasks submit <taskId>
jinn tasks status <taskId>
```

Internally, those commands may map to `TaskCoordinator` and `JinnRouter` calls using round, attempt, and request identifiers.

## 5. Current constraints

The OLAS Mech Marketplace and current router path are single-delivery per marketplace request:

- `MechMarketplace` stores one delivered mech for each `requestId`.
- `JinnRouter` records one delivery claim per `requestId`.
- `ClaimRegistry` stores one active claim per `requestId`.
- The current client persistence path is keyed primarily by `request_id`.

This spec does not attempt to make one marketplace `requestId` accept many deliveries. That would require a deeper marketplace fork or wrapper.

Instead:

```text
one public Task
  -> many internal attempts
  -> one marketplace requestId per attempt
  -> one Solution per attempt
```

This is not the rejected "sibling Tasks" workaround. All attempts share one canonical Task payload and one Task lifecycle identity.

## 6. TaskCoordinator responsibilities

`TaskCoordinator` is the canonical shared Task lifecycle contract.

It owns:

- Task lifecycle identity.
- Immutable `taskCid` digest.
- `solverType` identifier or digest.
- Creator/sponsor.
- Policy config.
- Claim window.
- Submission deadline.
- Claim lease TTL.
- `maxClaims`.
- `maxClaimsPerOperator`.
- Attempt allocation.
- Active claim leases.
- Per-operator participation limits for a Task.
- Mapping from attempt to marketplace `requestId`.
- Mapping from marketplace `requestId` back to Task and attempt.
- Submission/delivery state for each attempt.
- Cancellation/closure state.

It does not own:

- OLAS Mech request mechanics.
- Current staking/activity counters.
- Prediction-specific market logic.
- Dashboard materialization.
- Corpus storage.
- Verdict scoring formulas.

Candidate state shape:

```solidity
enum TaskStatus {
    None,
    Open,
    Closed,
    Cancelled
}

enum AttemptStatus {
    None,
    Claimed,
    RequestRegistered,
    Submitted,
    Released,
    Expired
}

struct TaskPolicy {
    uint64 claimWindowStart;
    uint64 claimWindowEnd;
    uint64 submissionDeadline;
    uint32 claimLeaseTtlSeconds;
    uint16 maxClaims;
    uint16 maxClaimsPerOperator;
    address policyHook;
}

struct TaskRecord {
    address creator;
    bytes32 taskCidDigest;
    bytes32 solverTypeDigest;
    TaskStatus status;
    TaskPolicy policy;
    uint32 claimCount;
    uint32 submittedCount;
}

struct AttemptRecord {
    uint256 taskId;
    uint32 attemptIndex;
    address operator;
    bytes32 requestId;
    uint64 claimedAt;
    uint64 claimExpiresAt;
    uint64 submittedAt;
    AttemptStatus status;
}
```

Names above are candidate Solidity names. Public product surfaces should use Task/Solution/Verdict language.

## 7. JinnRouter responsibilities

`JinnRouter` remains the bridge to OLAS Mech and current activity accounting.

It owns:

- Creating Mech marketplace requests for attempts.
- Forwarding marketplace payment.
- Registering request IDs with `TaskCoordinator`.
- Verifying marketplace delivery status.
- Recording current staking-compatible activity counters.
- Preserving compatibility with existing creation/delivery/evaluation activity checks where practical.

It does not own:

- Per-Task claim policy.
- Per-operator one-to-many participation limits.
- Shared Task lifecycle state.
- Prediction-specific evaluation rules.

For shared Tasks, the router should expose operator-facing methods that keep the mental model simple. Candidate method names may be contract-level and need not leak to CLI:

```solidity
function createTask(...) external payable returns (uint256 taskId);
function claimTask(uint256 taskId) external returns (uint32 attemptIndex, bytes32 requestId);
function claimDelivery(bytes32 requestId, bytes32 evidenceHash) external;
```

Internally, `claimTask` should:

1. Call `TaskCoordinator.claimTask(taskId, operator)`.
2. Create one Mech marketplace request for the allocated attempt.
3. Call `TaskCoordinator.registerAttemptRequest(taskId, attemptIndex, requestId)`.
4. Emit a Task submission/attempt event for indexers.

If any step fails, the whole transaction should revert so the operator is not left with a claimed attempt that has no request.

## 8. Funding model for lazy attempts

Lazy attempt creation avoids pre-creating unused marketplace requests, but the operator should not pay to create their own attempt request.

For v1, the Task creator/sponsor funds attempt creation through the router:

```text
Task creation:
  creator deposits maxClaims * perAttemptPayment, or an equivalent bounded budget.

Task claim:
  router consumes one per-attempt payment from the Task budget.
  router forwards that payment to MechMarketplace.request(...).

After claim window:
  creator can reclaim unused attempt budget.
```

This preserves the operator-facing flow:

```text
claim -> run -> submit
```

It also keeps high-volume Prediction posting bounded. `maxClaims` becomes both a participation cap and a budget cap. A claim that creates a marketplace request may consume budget even if the operator later no-shows.

Testnet deployments may use a zero or flat payment path where available, but the contract boundary should still account for funded attempt creation.

## 9. Lifecycle flow

### 9.1 Task posting

1. The generator or creator builds an immutable Task JSON document.
2. The Task JSON is uploaded to IPFS or the configured content store.
3. The creator calls the router to create a Task.
4. The router forwards Task lifecycle data to `TaskCoordinator`.
5. `TaskCoordinator` records the Task and emits a creation event.

No Mech marketplace request is created at Task posting time in the lazy-attempt design.

Required event intent:

```solidity
event TaskCreated(
    uint256 indexed taskId,
    address indexed creator,
    bytes32 indexed solverTypeDigest,
    bytes32 taskCidDigest,
    uint16 maxClaims,
    uint64 claimWindowStart,
    uint64 claimWindowEnd,
    uint64 submissionDeadline
);
```

### 9.2 Claiming

1. The operator sees an open Task through the daemon, CLI, dashboard, or indexer.
2. The operator invokes the public "claim Task" action.
3. The client routes this to `JinnRouter.claimTask(taskId)` through the operator Safe.
4. The router asks `TaskCoordinator` to allocate one attempt to the operator.
5. The router creates a Mech marketplace request for that attempt using the Task CID and attempt metadata.
6. The router registers the returned `requestId` with `TaskCoordinator`.
7. The operator's daemon receives the `requestId` it should submit against.

Policy enforced by `TaskCoordinator`:

- Task must be open.
- Current time must be inside the claim window.
- Current time must be before the submission deadline.
- Task must not exceed `maxClaims`.
- Operator must not exceed `maxClaimsPerOperator`.
- Operator must pass optional `policyHook.canClaim(...)`.
- Claim lease expiry must not exceed submission deadline.

Required event intent:

```solidity
event TaskClaimed(
    uint256 indexed taskId,
    uint32 indexed attemptIndex,
    address indexed operator,
    uint64 claimExpiresAt
);

event TaskAttemptRequestRegistered(
    uint256 indexed taskId,
    uint32 indexed attemptIndex,
    bytes32 indexed requestId
);
```

### 9.3 Running and submitting

1. The operator's Harness runs the Task.
2. The Harness produces a Solution envelope.
3. The operator delivers the Solution to the Mech marketplace request ID for its attempt.

This should feel like the current delivery flow to operators. The difference is only that the request ID was created as an attempt under a shared Task.

### 9.4 Delivery claiming and activity counting

After marketplace delivery:

1. The router or delivery watcher calls `claimDelivery(requestId, evidenceHash)`.
2. The router checks that the request ID belongs to a `TaskCoordinator` attempt.
3. The router checks the Mech Marketplace delivery status.
4. The router verifies the delivery is attributable to the operator/mech expected for that attempt.
5. The router records current staking-compatible activity counters.
6. The router calls `TaskCoordinator.recordSubmission(requestId, deliveryCidDigest, submittedAt)`.

`TaskCoordinator` records lifecycle truth. `JinnRouter` records v1 activity counts.

Required event intent:

```solidity
event TaskSubmitted(
    uint256 indexed taskId,
    uint32 indexed attemptIndex,
    address indexed operator,
    bytes32 requestId,
    bytes32 solutionCidDigest
);
```

### 9.5 Evaluation

Evaluation remains per Solution:

- Each submitted Solution can receive one Verdict.
- There is no first-valid-wins path in the first policy.
- There is no best-of-K on-chain winner in v1.
- There is no on-chain aggregate score for the Task in v1.

For Prediction SolverNet v1, the evaluator waits for the external market's final YES/NO/INVALID outcome and scores each valid Solution against the same Task consensus snapshot and resolution rule.

Verdicts are indexed through the corpus/envelope path defined by the Prediction lifecycle design. The coordinator may expose enough request/attempt mapping for indexers to group Verdicts by Task.

## 10. First policy: parallel submissions

The first policy needed by Prediction SolverNet is:

```json
{
  "mode": "parallel",
  "maxClaims": 25,
  "maxClaimsPerOperator": 1,
  "claimLeaseTtlSeconds": 1800,
  "claimWindowSeconds": 600,
  "submissionWindowSeconds": 1800,
  "selection": "all-valid-solutions-scored",
  "economics": "testnet-bounded-budget"
}
```

Rules:

- Many operators may claim the same Task.
- Each operator Safe may claim at most one attempt slot for that Task.
- Each claimed slot maps to one Mech request ID.
- Each request ID can receive one Solution.
- Every valid Solution is scored independently.
- Invalid, late, or malformed Solutions are rejected per the SolverType's evaluator rules.
- Expired claim leases mark the attempt as stale if no submission is finalized.
- The Task creator/sponsor bounds spend with `maxClaims`.

For Prediction SolverNet v1:

- Market time to resolution remains 24 hours to 7 days.
- Solver claim/submission windows are short and shared after Task posting.
- The posted-time consensus snapshot is the benchmark anchor.
- Operators do not trade on Polymarket as part of completing the Task.

## 11. Policy hooks

`TaskCoordinator` should support an optional policy hook for eligibility that can vary by Task or SolverNet.

Candidate interface:

```solidity
interface ITaskPolicyHook {
    function canClaim(
        address operator,
        uint256 taskId,
        bytes32 solverTypeDigest
    ) external view returns (bool);
}
```

The hook may reject a claim, but it must not own core lifecycle state. State mutation stays in `TaskCoordinator`.

This gives future campaigns room to add allowlists, reputation requirements, staking thresholds, or phase gates without deploying a new coordinator.

## 12. Activity counting

Activity counting remains in `JinnRouter` for v1.

Rationale:

- Existing staking/activity infrastructure already points at router-oriented counters and checks.
- `TaskCoordinator` should be generic lifecycle state, not reward policy.
- Reward/accounting rules will likely change independently from Task lifecycle rules.

Boundary:

```text
TaskCoordinator says:
  This Task exists, this operator claimed this attempt, this request belongs to this attempt, this attempt submitted.

JinnRouter says:
  This delivered attempt counts as restoration/execution activity under the current staking bridge.
```

Future direction:

```text
ActivityLedger
  recordActivity(operator, activityType, taskId, attemptIndex, weight, metadataCid)
```

`ActivityLedger` is explicitly out of v1. The router boundary should avoid baking SolverNet-specific activity semantics into `TaskCoordinator` so the ledger can be introduced later.

## 13. Upgradeability

`TaskCoordinator` should be deployed behind an upgradeable proxy on testnet. The implementation can reuse the repo's existing UUPS-style proxy pattern or an equivalent audited proxy pattern.

Requirements:

- Multisig/governance-controlled upgrades.
- Explicit initializer.
- No constructor-only state.
- Storage layout tests before upgrade.
- Events for implementation upgrades if the proxy pattern does not already expose them.
- Conservative storage gaps or appended-only storage layout.

Design intent:

- New SolverTypes should reuse the same coordinator.
- New claim policies should usually be config or hook changes.
- New lifecycle semantics should be implementation upgrades, not new one-off registries.
- Prediction-specific behavior should stay in the Task payload, plugin, generator, evaluator, or policy config, not in the coordinator core.

## 14. Implementation handoff

### 14.1 `jinn-mono-kod`

Implement the shared Task coordination path:

- `TaskCoordinator` proxy and implementation.
- Router integration for `createTask` and `claimTask`.
- Lazy Mech request creation using creator-funded per-attempt budget.
- Delivery mapping from `requestId` to Task/attempt.
- Claim lease expiry/release behavior.
- Indexable Task/claim/submission events.
- Tests for max submissions, per-operator cap, expiry, refund, and delivery mapping.

Do not force this through the current `ClaimRegistry`.

### 14.2 `jinn-mono-l2zl.3`

The Polymarket-derived generator should post one shared Prediction Task per eligible market, not sibling duplicate Tasks.

Generator defaults remain from the Prediction lifecycle plan:

- Eligible markets resolve in 24 hours to 7 days.
- One Task uses one immutable consensus snapshot.
- `maxClaims` default starts at 25.
- Claim/submission windows are short and shared.
- Every valid Solution is scored later.

### 14.3 `jinn-mono-l2zl.4`

The end-to-end Prediction flow should group all submissions by Task ID/task CID and score each valid Solution independently.

E2E must show:

- Multiple operators claim one public Task.
- Each operator receives a distinct request ID internally.
- Each operator submits one Solution.
- The evaluator produces one Verdict per valid Solution.
- Dashboard/corpus views group the submissions under the shared Task.

### 14.4 `jinn-mono-xp33`

The dashboard should use public Task and submission vocabulary.

Minimum grouping keys:

- `taskId` or `taskCid`.
- `solverType`.
- `operator`.
- `harness`.
- `plugin`.
- `solutionEnvelopeCid`.
- `verdictEnvelopeCid`.
- Internal `requestId` and `attemptIndex` for trace/debug only.

Dashboard metrics should not treat each attempt request as a separate public Task.

## 15. Out of scope

- Forking the OLAS Mech Marketplace to accept many deliveries per one request ID.
- Mainnet campaign launch.
- On-chain best-of-K winner selection.
- On-chain aggregate scoring.
- Multi-evaluator consensus.
- Trading execution.
- Generic `ActivityLedger`.
- Public operator UX copy beyond the naming boundary in this spec.

## 16. Open implementation questions

These should be answered during implementation design, not by changing the architectural boundary:

- Exact native/payment-token escrow mechanics for per-attempt budgets.
- Whether `taskId` is a sequential integer, deterministic digest, or both.
- Exact request data encoding for Mech attempt requests.
- How the router proves delivered mech/operator attribution with the current Mech interfaces.
- Whether evaluation request creation remains router-only or gets a Task-aware helper.
- Whether claim lease expiry is passive, permissionless garbage collection, or both.
- Whether an expired attempt with a registered but undelivered marketplace request can be reassigned, or whether it is treated as consumed budget for v1.
