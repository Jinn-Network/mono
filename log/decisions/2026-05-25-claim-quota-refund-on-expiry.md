---
id: DR-2026-05-25
title: TaskCoordinator — refund per-operator (and task-wide) claim quota on attempt expiry
date: 2026-05-25
verb: Steer
status: rejected
rejected-on: 2026-05-26
authors: opus (drafted in design/576-…; design note: docs/superpowers/specs/2026-05-25-issue-576-claim-quota-refund-design-note.md)
amends: DR-2026-05-22-a
relates-to: issue #576, issue #545, issue #569
---

## Decision update (2026-05-26) — REJECTED

Status flipped to `rejected` after review. The brainstorming note (Stage 1)
and this DR (Stage 2) stay in-tree as a record of the considered alternative;
future "why don't we refund on expiry?" questions are answered here.

**Reasoning:**

- **Anti-Sybil / claim-as-commitment is the intended property.** Every claim
  costing a slot — permanently, regardless of outcome — is the mechanism that
  makes claiming meaningful. Refunding turns claim into a free option and
  re-opens the chain-claim-expire grief surface this DR itself concedes (§9:
  `~40% of a 1-day swe-rebench-v2 posting` denial window per (task, operator)
  under the bare refund-with-cap proposed below).

- **The cited 2026-05-25 incident (OpenRouter monthly-cap 403) is
  operator-side, not protocol-side.** PR #477 (merged 2026-05-25) introduced a
  per-credential daily spend-cap gate that refuses to claim when the
  credential's spend cap is reached. The trigger case is now prevented
  upstream at the right layer (refuse to claim) rather than the wrong layer
  (claim, fail, plead for refund).

- **Recovery already exists at the posting-rotation timescale.** The DR
  itself notes (§Context) that the per-operator counter resets across
  postings; the generator reposts the same instance on the next cycle. The
  "permanent lockout" is bounded by repost cadence, not by the protocol.

- **Grief mitigation belongs in Phase B.2 bond-and-slash**, not in a
  pre-submission refund path that pulls grief surface forward. The DR
  defers bond-and-slash to Phase B.2 anyway; that's the right home for the
  honest-operator recovery story too.

Original proposal below preserved unchanged for record.

---

## Context

GitHub issue [#576](https://github.com/Jinn-Network/mono/issues/576) flagged that
`TaskCoordinator.claimTask` gates per-operator claims with two increment-only
counters
([`contracts/src/tasks/TaskCoordinator.sol:330-346`](../../contracts/src/tasks/TaskCoordinator.sol#L330-L346)):

```solidity
if (record.claimCount >= policy.maxClaims) revert TCMaxClaimsReached(taskId);
if (claimsByTaskByOperator[taskId][operator] >= policy.maxClaimsPerOperator) {
    revert TCOperatorClaimLimitReached(taskId, operator);
}
// ...
record.claimCount++;                              // line 345
claimsByTaskByOperator[taskId][operator]++;       // line 346
```

`expireAttempt`
([`contracts/src/tasks/TaskCoordinator.sol:579-587`](../../contracts/src/tasks/TaskCoordinator.sol#L579-L587))
flips an attempt's status to `Expired` and emits `TaskAttemptExpired` but does
not touch either mapping; `recordSubmission` sets `AttemptStatus.Submitted` at
line 408. So when an attempt fails for any reason that does not produce an
on-chain submission — transient API errors, RPC outage, daemon crash
mid-attempt, lease elapsed without delivery — the slot is permanently consumed
against both quotas. The contract treats "claimed and delivered" and "claimed
and runtime exploded" identically.

DR-2026-05-22-a's "Contract finding — claim slots are a one-way budget"
established the same shape at the task level:

> `TaskCoordinator.sol` `claimTask` does `record.claimCount++` (line 345) and
> gates on `claimCount >= maxClaims` (line 330). `expireAttempt` (lines 579-587)
> marks a stale attempt `Expired` but **never decrements `claimCount`**. So every
> claim — success, failure, or expired lease — permanently burns one of the
> `maxClaims` slots; once the budget is spent the Task is permanently closed to
> new claims. A posting is a fixed attempt budget that cannot self-heal.

That DR leaned on time-expiry of the whole posting as the heal — when a
posting's window elapses, the generator reposts the instance with a fresh
budget. This DR is the per-operator generalisation. Reposting rotates `taskId`,
so the per-operator counter resets *across* postings, but within a single task
the operator stays locked out.

**Trigger.** On 2026-05-25 this operator's daemon claimed tasks `0x6d4cc88a…`
and `0x2b11ad47…`; both attempts hit an OpenRouter monthly-cap 403 inside the
hermes subprocess and `task_runs` went to FAILED. The two on-chain slots are
now consumed; the operator cannot re-attempt those tasks even after the cap
was resolved. (The issue body originally cited address `0xdC9BCcEB…`; that
proxy is `JinnRouterV3`. The real TaskCoordinator proxy is
`0x9ce736d3CB367cC5Db538B7962bdf416EbD7451B`.)

**`expireAttempt` is currently never invoked anywhere outside Solidity tests** —
a repo-wide grep finds no call from the daemon, the router, the generator, or
any other contract. Today's status quo is therefore stricter than the contract
spec: the `Expired` status is dormant, attempts that exceed their lease sit in
`Claimed` or `RequestRegistered` forever, and no event fires. The decision
below addresses both the *semantics* of expiry and the *activation* of the
expiry path.

## Decision

`expireAttempt` becomes a refund path, capped per `(taskId, operator)` to bound
grief.

1. **Refund both quotas on expiry from a pre-submission state.** When an attempt
   transitions to `AttemptStatus.Expired`, if its prior status was `Claimed` or
   `RequestRegistered`, decrement `claimsByTaskByOperator[taskId][operator]`
   *and* `_tasks[taskId].claimCount`. No decrement when the prior status was
   `Submitted` — at that point the operator has committed an artifact and pays
   the slot cost regardless of evaluation outcome.

2. **Per-`(task, operator)` refund cap of 2.** A new mapping
   `refundedClaimsByTaskByOperator[taskId][operator]` (uint8) is incremented on
   each refund. Once it reaches the contract constant
   `MAX_REFUNDS_PER_OPERATOR_PER_TASK = 2`, the third and subsequent expiries
   still transition the attempt to `Expired` and emit `TaskAttemptExpired`, but
   do *not* refund. Bad-luck recovery for honest operators; hard ceiling on
   indefinite-repeat grief.

3. **New event `TaskAttemptRefunded`** emitted alongside `TaskAttemptExpired`
   whenever the refund branch fires, so indexers and the operator app can
   account for refunds without parsing expiry-event fields:

   ```solidity
   event TaskAttemptRefunded(
       uint256 indexed taskId,
       uint32 attemptIndex,
       address indexed operator,
       uint16 newClaimCount,
       uint8 newOperatorClaimCount
   );
   ```

4. **Daemon-side activation.** The daemon opportunistically calls
   `expireAttempt(taskId, attemptIndex)` from its post-failure / lease-elapsed
   path so the refund lands without external prodding. Bounded by the cap; a
   buggy daemon cannot loop-grief itself.

`expireAttempt` stays permissionless — any party (the operator themselves, a
watchdog, the router on next claim) can trigger the refund.

## Implementation sketch

Pseudo-diff against
[`contracts/src/tasks/TaskCoordinator.sol`](../../contracts/src/tasks/TaskCoordinator.sol):

```solidity
// New storage (appended slot — see Migration).
mapping(uint256 => mapping(address => uint8)) public refundedClaimsByTaskByOperator;
uint8 public constant MAX_REFUNDS_PER_OPERATOR_PER_TASK = 2;

// New event.
event TaskAttemptRefunded(
    uint256 indexed taskId,
    uint32 attemptIndex,
    address indexed operator,
    uint16 newClaimCount,
    uint8 newOperatorClaimCount
);

// Modified expireAttempt (replaces lines 579-587).
function expireAttempt(uint256 taskId, uint32 attemptIndex) external {
    AttemptRecord storage attempt = _attempts[taskId][attemptIndex];
    if (attempt.status == AttemptStatus.None) revert TCAttemptNotFound(taskId, attemptIndex);
    if (attempt.status == AttemptStatus.Submitted) revert TCAttemptAlreadySubmitted(taskId, attemptIndex);
    if (attempt.status == AttemptStatus.Expired) return;
    if (block.timestamp <= attempt.claimExpiresAt) revert TCClaimNotExpired(taskId, attemptIndex);

    AttemptStatus prior = attempt.status;
    attempt.status = AttemptStatus.Expired;

    address op = attempt.operator;
    bool refundable =
        (prior == AttemptStatus.Claimed || prior == AttemptStatus.RequestRegistered) &&
        refundedClaimsByTaskByOperator[taskId][op] < MAX_REFUNDS_PER_OPERATOR_PER_TASK;

    if (refundable) {
        TaskRecord storage record = _tasks[taskId];
        if (claimsByTaskByOperator[taskId][op] > 0) {
            claimsByTaskByOperator[taskId][op]--;
        }
        if (record.claimCount > 0) {
            record.claimCount--;
        }
        refundedClaimsByTaskByOperator[taskId][op]++;
        emit TaskAttemptRefunded(
            taskId,
            attemptIndex,
            op,
            record.claimCount,
            claimsByTaskByOperator[taskId][op]
        );
    }

    emit TaskAttemptExpired(taskId, attemptIndex, op);
}
```

**Tests.** Refund-path coverage lands in
[`contracts/test/TaskCoordinator.test.ts`](../../contracts/test/TaskCoordinator.test.ts):

- expiry from `Claimed` refunds both counters and emits `TaskAttemptRefunded`;
- expiry from `RequestRegistered` refunds both counters;
- expiry from `Submitted` does not refund;
- the third expiry from a pre-submission state emits `TaskAttemptExpired` but
  not `TaskAttemptRefunded`, and the counters do not move;
- after a refund the operator can re-claim against the same task up to
  `maxClaimsPerOperator`.

A new upgrade test under
[`contracts/test/jinn/upgrade/`](../../contracts/test/jinn/upgrade/) confirms
pre-upgrade `claimsByTaskByOperator` and `_tasks[taskId].claimCount` values are
preserved across the implementation swap and the new mapping reads zero on
pre-existing keys.

The daemon hook lives in `client/src/daemon/` (precise file owned by the
follow-up `feat` issue).

## Migration

The deployed testnet `TaskCoordinator` is a UUPS proxy at
`0x9ce736d3CB367cC5Db538B7962bdf416EbD7451B` (per
[`contracts/deployment-task-coordinator-router-v3-baseSepolia-fast.json`](../../contracts/deployment-task-coordinator-router-v3-baseSepolia-fast.json)).
Migration is an in-place implementation upgrade via
[`contracts/scripts/upgrade-task-coordinator-router-v3.ts`](../../contracts/scripts/upgrade-task-coordinator-router-v3.ts).

- The new mapping `refundedClaimsByTaskByOperator` and constant
  `MAX_REFUNDS_PER_OPERATOR_PER_TASK` append a single storage slot; existing
  layout is unchanged.
- The new event `TaskAttemptRefunded` is additive. The ABI-invariance test
  [`contracts/test/jinn/upgrade/AbiInvariance.test.ts`](../../contracts/test/jinn/upgrade/AbiInvariance.test.ts)
  only flags removed events / functions, so the addition is fine.
- Bump the implementation version constant per existing upgrade convention.

**Already-expired attempts on already-deployed tasks are not retroactively
refunded.** The two slots this operator lost on 2026-05-25 stay lost; the cost
is small in absolute terms and a one-shot owner-only `backfillRefund` would add
migration code for a single incident on testnet. Accept the loss.

## Grief analysis

The abuse pattern under any refund design is uniform: an adversarial operator
claims `maxClaimsPerOperator` slots, never submits, waits for the
`claimLeaseTtlSeconds` lease to elapse, triggers the refund, repeats. Today's
leases: `prediction.v1` 30 min, `swe-rebench-v2` 1 h, session-derived 4 h.
Without the per-window cap, an adversary holding 5 slots on a `swe-rebench-v2`
posting (1 h lease, 1 d window) can deny the posting ~24 times at gas-only cost
— honest operators pay gas plus LLM compute per claim; the asymmetry is
structural.

The per-`(task, operator)` refund cap of 2 converts indefinite-repeat grief
into a bounded denial window of
`2 × maxClaimsPerOperator × claimLeaseTtlSeconds`. For `swe-rebench-v2` today
that is `2 × 5 × 1 h = 10 h` of denial inside a 1-day `posting_window_ms` —
≈ 40% of the window. After two refunded expiries the adversary is permanently
slot-locked on that task. This residual exposure is the cost of not introducing
a bond mechanism in this DR. Bond-and-slash for claim-slot grief is deferred to
Phase B.2 — challenge-mechanism economics is the natural home for slashing.
The thin-operator testnet protects us in the short term.

## Interaction with `requiredVerdicts` and finalisation

Refund unconditionally on expiry; do not gate on finalisation status. The cases
where a refund is "useless" (the task's `claimWindowEnd` has already passed, so
no new claim can land) are also cases where the refund is "harmless" — the
counter decrement is purely cosmetic but stays useful as a state-cleanliness
signal for downstream indexers. Gating on finalisation adds code for zero
behavioural benefit.

`TaskStatus.Closed` is never assigned anywhere in `TaskCoordinator.sol` today
(`recordVerdict` lines 555-576 set per-attempt `finalization = Passed | Failed`
without closing the task), so there is no finalisation-driven contract path the
refund would need to coordinate with. DR-2026-05-22-a already accepts mild
overshoot past `N_target_successes` from late verdicts and treats per-posting
`maxClaims` as a soft target; refunding a slot whose work never produced a
verdict cleanly composes with that framing.

## Interaction with related issues

- **[#545 — Credit-readiness gate doesn't fire on resume]:** Composes cleanly.
  The resume-readiness gap is independent of contract semantics. Fixing #545
  reduces the rate at which the refund path actually fires (fewer
  daemon-restart-into-exhausted-key burns); the contract change still covers the
  daemon-crash-mid-attempt and provider-blip cases that no operator-side gate
  can catch. Ship #545 in parallel under the same release branch.
- **[#562 — Safe nonce-too-low retry helper]:** Closed (merged 2026-05-25).
  Positive interaction — that fix reduces the rate of
  "daemon-meant-to-call-`expireAttempt`-but-tx-dropped" scenarios under this
  DR. No design coupling.
- **[#569 — `claim` vs `attempt` vocabulary unification]:** Touches the same
  contract surface. The new event name `TaskAttemptRefunded` follows the
  existing `TaskAttempt*` family (`TaskAttemptExpired`,
  `TaskAttemptRequestRegistered`) and should be revisited if #569 ratifies a
  different canonical noun. If #569 lands first, this DR's implementation
  follow-up renames to match.

## Consequences

- **Storage.** New mapping `refundedClaimsByTaskByOperator` + constant; append-
  only, no existing slot moves, UUPS-safe.
- **ABI.** Additive new event `TaskAttemptRefunded`; ABI-invariance test does
  not flag.
- **Indexer.** Ponder gains a `TaskAttemptRefunded` handler that decrements its
  derived `claimsByTaskByOperator` / `claimCount` projections to match chain.
- **Operator app.** Surfaces "refunded N of 2" per `(task, operator)`. The §2.6
  Tasks component gains a refund counter in its state-message axis.
- **Silent cap absorption.** The third expiry transitions to `Expired` without
  emitting `TaskAttemptRefunded`; operators reading
  `refundedClaimsByTaskByOperator` directly can detect the cap. A separate
  `TaskAttemptRefundCapped` event is deferred unless reviewers ask — adding it
  later is an additive ABI change.
- **Daemon.** The opportunistic `expireAttempt` call is bounded by the contract
  cap, so a buggy daemon (e.g. one that mis-detects failure) cannot loop-grief
  itself or anyone else past the 2-refund ceiling.

## Alternatives considered

- **Option B — operator-side readiness gates only.** The daemon already runs
  `gateClaimByReadiness`
  ([`client/src/daemon/daemon.ts:530`](../../client/src/daemon/daemon.ts#L530))
  and the hermes harness probes OpenRouter credit
  ([`client/src/harnesses/impls/hermes-agent/harness.ts:141-161`](../../client/src/harnesses/impls/hermes-agent/harness.ts#L141-L161)).
  Rejected: gates fix the *rate*, not the *existence* of slot loss. They cannot
  catch daemon-crash-mid-attempt, the probe-vs-fail race (provider returns 200
  to `/api/v1/key`, 402 on the next chat completion), or the resume-of-in-flight
  bypass (#545). They also do nothing for slots already burned.
- **Option C.1 — refund only on `Claimed`-not-`RequestRegistered` expiry.**
  Smaller surface, but the `RequestRegistered → Expired` path (mech request
  posted, agent crashed before delivery) is the more common operator failure
  shape; excluding it loses most of the refunds operators actually need.
- **Option C.2 — `cancelOwnAttempt(taskId, attemptIndex, reason)` with a caller
  bond.** Adds a new mutation surface and a token-economics surface (bond size,
  bond destination). Deferred to Phase B.2 bond-and-slash; the transient-failure
  problem this DR addresses does not justify a new economic surface.
- **Option D — status quo.** Defensible under the old flat caps (5 slots, easy
  to recover by claiming a different task). Rejected under DR-2026-05-22-a:
  the generator now pins `maxClaimsPerOperator = maxClaims = N − successful_count`
  per posting (≤ 5), so each lost slot is a lost trajectory. Losing 2/5 in one
  ops blip is meaningful.

## Open / deferred

- Bond-and-slash mechanism timing — proposed defer to Phase B.2, accepting the
  ≈ 40% per-posting denial window as the cost of no-bond inside this DR.
  Captain confirms or escalates.
- Refund cap as contract constant (`MAX_REFUNDS_PER_OPERATOR_PER_TASK = 2`,
  proposed) vs `TaskPolicy` field — proposed constant for simplicity. If a
  SolverNet later needs a different cap (session-derived's 4-hour leases
  probably want a lower one), file a follow-up to promote it to a policy field.
- Backfill for already-burned slots from 2026-05-25 — proposed accept the loss.
  Testnet, minimal absolute cost, does not justify the migration code for a
  one-shot owner-only `backfillRefund`.
- Implementation issue must be filed as the `feat` follow-up once this DR is
  ratified: contract change + UUPS upgrade + Ponder handler + operator-app
  refund-counter surface + daemon `expireAttempt` hook. Ship #545 in parallel
  under the same release branch.

## Status

- Proposed — pending Captain review. Implementation deferred to follow-up
  `feat` issue under this DR.
