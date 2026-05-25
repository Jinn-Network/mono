---
date: 2026-05-25
issue: https://github.com/Jinn-Network/mono/issues/576
shape: design (Stage 1 brainstorming note — feeds Stage 2 DR)
status: draft
authors: opus (design subagent, headless)
relates-to: DR-2026-05-22-a, issue #545, issue #562, issue #569
---

# Design note — per-operator claim quota refund on attempt expiry (issue #576)

## 1. Problem

`TaskCoordinator.claimTask` gates per-operator claims with two checks
(`contracts/src/tasks/TaskCoordinator.sol:330-333`):

```solidity
if (record.claimCount >= policy.maxClaims) revert TCMaxClaimsReached(taskId);
if (claimsByTaskByOperator[taskId][operator] >= policy.maxClaimsPerOperator) {
    revert TCOperatorClaimLimitReached(taskId, operator);
}
// ...
record.claimCount++;                              // line 345
claimsByTaskByOperator[taskId][operator]++;       // line 346
```

`claimsByTaskByOperator` and `record.claimCount` are **only ever incremented**.
`expireAttempt` (lines 579-587) flips the attempt's status to `Expired` and
emits `TaskAttemptExpired`, but does not touch either counter. Verified by
grep — neither mapping has a decrement path anywhere in the repo.

Concrete consequence (observed 2026-05-25, this operator):
1. Operator's daemon claims task `0x6d4cc88a…` → `claimsByTaskByOperator[…][op]++`.
2. Hermes subprocess spawns, hits an OpenRouter monthly-cap 403.
3. `task_runs` row goes FAILED. The attempt's lease expires at `claimExpiresAt`.
4. The per-operator counter remains at 1 of 5. Subsequent claim against the
   same task is unaffected, but the slot can never be returned. Same shape on
   `0x2b11ad47…` — two of the operator's five slots permanently spent on a
   transient provider failure.

For SolverNets where the launcher pins `maxClaimsPerOperator = maxClaims =
N − successful_count` (the post-DR-2026-05-22-a `swe-rebench-v2` shape — see
`packages/sdk/src/contracts.ts:167-172`, with the generator overriding both
caps per posting), a single operator can hold every slot, but a single
operator's ops blip then strands the whole task: nobody else can claim
either, because `maxClaims` is also at the per-operator quota.

**Relation to DR-2026-05-22-a.** That DR's "Contract finding — claim slots
are a one-way budget" paragraph established the same shape at the task level
(`claimCount` gated by `maxClaims`). It chose **not** to fix the one-way
budget; instead it leaned on **time-expiry of the whole posting** as the
heal — when a posting's window elapses, the generator reposts the instance
with a fresh budget. Issue #576 is the same finding at the per-operator
level. The DR-2026-05-22-a heal does not cover the per-operator case:
reposting creates a new `taskId`, so the per-operator counter resets, but
only because the task identity itself rotated. Within a single task the
operator stays locked out.

A second relevant pattern: **`expireAttempt` is never invoked from the TS
codebase, the daemon, the router, or any other contract** — only from
Solidity tests. So today's behaviour is even stricter than the contract
allows: the `Expired` status is dormant. Status-quo Option D (below) is in
practice "the slot is consumed forever AND the attempt sits in `Claimed`
state forever AND no event fires."

## 2. Options

### Option A — Refund-on-expiry (contract change)

Modify `expireAttempt` to decrement both quota counters when an attempt
expires without a recorded submission. Sketch:

```solidity
function expireAttempt(uint256 taskId, uint32 attemptIndex) external {
    AttemptRecord storage attempt = _attempts[taskId][attemptIndex];
    if (attempt.status == AttemptStatus.None) revert TCAttemptNotFound(...);
    if (attempt.status == AttemptStatus.Submitted) revert TCAttemptAlreadySubmitted(...);
    if (attempt.status == AttemptStatus.Expired) return;
    if (block.timestamp <= attempt.claimExpiresAt) revert TCClaimNotExpired(...);

    attempt.status = AttemptStatus.Expired;

    // Refund slot to operator AND to the task-wide budget.
    TaskRecord storage record = _tasks[taskId];
    if (claimsByTaskByOperator[taskId][attempt.operator] > 0) {
        claimsByTaskByOperator[taskId][attempt.operator]--;
    }
    if (record.claimCount > 0) {
        record.claimCount--;
    }

    emit TaskAttemptExpired(taskId, attemptIndex, attempt.operator);
}
```

Generalises DR-2026-05-22-a's finding: the one-way budget becomes
"successful + in-flight + delivered-pending-evaluation" rather than "ever
claimed." Two important sub-decisions inside this option:

- **What counts as "successful"?** The simplest rule that preserves the
  memorisation cap is to consider a slot consumed once the attempt reaches
  `AttemptStatus.Submitted` (line 408 in `recordSubmission`). At that point
  the operator has produced an on-chain artifact; the network commits to
  evaluation, whether the verdict ultimately passes or fails. So the rule
  is: **refund on Expired-from-Claimed and Expired-from-RequestRegistered;
  do not refund on Submitted-then-rejected.** A failed verdict still
  consumes a slot. This matches the intuition in DR-2026-05-22-a that
  `N_target_successes` is about score=1 verdicts, but the **slot cost** is
  paid at delivery, not at evaluation.
- **Migration.** `TaskCoordinator` is **proxied** (UUPS-style); the
  testnet deployment (`contracts/deployment-task-coordinator-router-v3-baseSepolia-fast.json`)
  has already been upgraded twice — current proxy at
  `0x9ce736d3CB367cC5Db538B7962bdf416EbD7451B`, impl at `0x047C9d27…`.
  An in-place implementation upgrade preserves all storage. The migration
  is `contracts/scripts/upgrade-task-coordinator-router-v3.ts` plus a new
  test in `contracts/test/TaskCoordinator.test.ts` that exercises the
  refund path. Existing attempts already in `Expired` status will not be
  retroactively refunded — that's fine; the counter for already-expired
  attempts on already-deployed tasks is unrecoverable without backfill.
  A one-shot owner-only `backfillRefund(taskId, attemptIndex)` could
  cover them but is YAGNI for the testnet.

`expireAttempt` is currently permissionless (no `onlyRouter`). That's
already correct for the refund design — any party (the operator
themselves, a watchdog, the router on next claim attempt) can trigger
the refund. We MAY want to add an opportunistic call inside the engine's
post-failure path so the slot is freed immediately rather than waiting
for the next external prod.

### Option B — Keep current semantics + operator-side readiness gates

The daemon already runs `gateClaimByReadiness` pre-claim
(`client/src/daemon/daemon.ts:530`) which calls the harness's
`probeReadiness`. The hermes-agent harness's fourth gate
(`client/src/harnesses/impls/hermes-agent/harness.ts:141-161`) probes
OpenRouter's `/api/v1/key` for spendable credit and returns
`ready: false` if remaining < floor — this is what prevented the
2026-05-23 op-b daemon from burning further claims after the OpenRouter
key hit $0.

Gaps the operator-side mitigation must close:

1. **Resume-of-in-flight bypass** — issue [#545]. The engine's resume
   path spawns hermes for already-claimed `RUNNING` task_runs without
   running the readiness composer, so a daemon restart into an
   exhausted-key state immediately burns the in-flight slot.
2. **Probe-vs-fail race** — credit-floor probing is sample-time; the
   provider can return 200 to `/api/v1/key` and 402 on the next chat
   completion (e.g. between probes the credit hits zero, or the model
   the harness picks is in a more expensive tier than the probe's
   estimate). Tightening the floor reduces the rate but not the
   existence of false-positive readiness.
3. **Daemon-crash mid-attempt** — the readiness gate cannot help. The
   attempt was claimed in a ready state and the daemon died before it
   could re-emit. The slot is permanently lost (under Option B).
4. **No remediation for slots already burned by previous incidents**
   — Option B does nothing for the two slots this operator already
   lost on 2026-05-25.

Option B's strongest defence is **grief resistance** — see §3.

### Option C — Hybrid (partial / conditional refund)

Refund only under explicit operator-disclosed reasons. Two flavours:

- **C.1 — Refund only on `Claimed`-not-`RequestRegistered` expiry.**
  If the attempt expires before the operator's mech registered the
  request via `registerAttemptRequest`, the slot was a bookkeeping
  ghost — no on-chain mech request was even posted; the operator has
  not entered the request-id namespace; the work didn't start. Refund
  is cheap and the grief surface is smaller because the operator must
  call `claimTask` again to repeat, which costs gas.
- **C.2 — Refund only with an operator-supplied cancellation reason
  + caller bond.** Add `cancelOwnAttempt(taskId, attemptIndex, reason)`
  callable by the attempt's operator before `claimExpiresAt`, refunds
  the slot, requires a small bond that's burned (or earmarked to the
  task creator) to make repeat grief expensive. Distinct from
  `expireAttempt` which is the "lease elapsed" path.

C.1 has the cleanest semantics: the on-chain state distinguishes the
case where the operator never produced *anything* from the case where
they produced a mech request that may or may not have settled. C.2 adds
a new mutation surface and a token-economics surface (bond size, where
the bond goes) that the DR would have to scope; YAGNI for what is
fundamentally a transient-failure problem.

### Option D — Status quo (accept the loss)

Defensible reasoning: today's flat caps (`maxClaimsPerOperator: 5` on
swe-rebench-v2; `1` on prediction.v1) are conservative; operators on a
healthy harness burn through 5 slots in minutes; the cost of losing
1-2 to provider hiccups is small in absolute terms; the team is fast at
shipping new postings. Counter-argument: under DR-2026-05-22-a the
generator now pins `maxClaimsPerOperator = N - successful_count` per
posting, so on a thin-operator network (which testnet is) every lost
slot is a lost trajectory — and the per-posting budget is small (≤ 5).
Losing 2/5 in one ops blip is meaningful. Status quo is the wrong call
unless grief vectors push us off A/C entirely.

## 3. Grief vectors

For each refund option, the abuse pattern is the same shape: an
adversarial operator claims `maxClaimsPerOperator` slots on a task,
never produces a mech request (or produces one and never delivers),
waits for `claimLeaseTtlSeconds`, gets refunded, repeats. The denial
window is `claimLeaseTtlSeconds × repeats`.

**Numbers.** Today's `claimLeaseTtlSeconds`:
- prediction.v1 — 30 min
- swe-rebench-v2 — 1 hour
- session-derived — 4 hours

Per-task denial budget under Option A by an adversary holding
`maxClaimsPerOperator = 5` slots:
- swe-rebench-v2 — 5 slots × 1 h per cycle, indefinitely-repeatable
  until the posting's `posting_window_ms` (1 d) elapses → up to ~24
  cycles. Honest operators cannot claim during the holds.

**Adversary cost in Option A:**
- Gas to call `claimTask` (one tx per slot, plus the OLAS-mech `request()`
  if the adversary registers a request; or zero if they just claim and
  never register).
- If the adversary triggers their own refund via `expireAttempt`, also
  gas there.
- **No token bond, no slash.** This is the relevant asymmetry: honest
  operators pay gas + provider compute per slot; adversarial holders
  pay gas only.

**Honest vs adversarial asymmetry.**
- Honest operator: pays gas + LLM compute, occasionally loses a slot
  to ops failure (today: permanent loss; under A: refunded).
- Adversary: pays gas only, can permanently deny the posting until
  the posting window expires.

**What closes the loop:**
1. **Bond-and-slash on expiry.** Require `claimTask` to take a small
   bond; refund on `Submitted`, burn on `Expired`. The bond must be
   large enough that repeat grief costs more than the value of the
   denied posting. This is a new economic surface that interacts with
   `JinnRouterV3`'s existing escrow accounting and the OLAS-mech
   request fee; it's a bigger design than this DR can absorb.
2. **Per-window operator cap.** Cap the number of `Expired` refunds
   any single operator can receive within a posting window — e.g.
   `maxRefundsPerOperator = 2`. After two refunded expiries, the
   operator is permanently slot-locked on this task. Stops the
   indefinite-repeat attack but caps the legitimate operator's
   bad-luck recovery at 2 per posting. Tractable inside this DR.
3. **Reduce `claimLeaseTtlSeconds`.** Shorter leases reduce the
   denial window per cycle but increase the chance that a slow
   honest operator's lease elapses before they submit. Already a
   per-SolverNet knob.
4. **Smaller `maxClaimsPerOperator`.** Caps the per-adversary share
   of any single task. Already a launcher knob; pinning it below
   `maxClaims` is exactly what DR-2026-05-22-a deferred to "once
   operator supply supports it."

**Verdict on grief vectors:** the bare Option A (no bond, no cap) is
exploitable on a network with even one motivated adversary. The
mitigation that fits this DR's scope is the **per-window refund cap**
(#2) — a single uint8 in storage per (taskId, operator), incremented
each time `expireAttempt` refunds, with a constant cap
(`MAX_REFUNDS_PER_OPERATOR = 2` or surface as a TaskPolicy field).
Option C.1 (refund only pre-`RequestRegistered`) compounds well: it
narrows the grief surface to "claim and never even start" which
costs the adversary nothing but a `claimTask` call — still grief-able,
but the per-window refund cap kills the indefinite-repeat dimension.

**A note on the thin-operator network.** On testnet today the
adversary surface is small — most slots are taken by op-a/op-b/op-c
who all live in the same Slack. The grief argument is more about
mainnet posture than current operations. But the DR has to land a
posture that works on mainnet, not just on the testnet where the
issue surfaced.

## 4. Interaction with `requiredVerdicts` and finalisation

The finalisation path (`recordVerdict` lines 555-576) sets
`finalization = Passed | Failed` on an attempt once
`validVerdictCount == requiredVerdicts`. Task status remains `Open`
(it can be moved to `Closed` only by an external action — currently no
contract path closes a task on finalisation; check shows
`TaskStatus.Closed` is never assigned anywhere in the .sol file).

So "the task closes when finalised" is **not** literally true in the
contract today — what is true is:
- `claimWindowEnd` time-bounds new claims regardless of
  finalisation.
- `submissionDeadline` time-bounds late submissions.
- `JinnRouterV3.refundUnusedTaskBudget` (line 313) lets the creator
  pull back leftover escrow once `claimWindowEnd` has passed.

**Implication for refund logic.** A "finalised task" in the
real-economic sense is a task whose `finalizedAttemptCount` already
satisfies the creator's intent (one passing attempt, in the
`requiredVerdicts = 1` default). Refunding slots on such a task is
**meaningful** in two cases:
1. The task's `claimWindowEnd` is still in the future. Refunded slots
   could be re-claimed by other operators who want to attempt the same
   task (e.g. for the corpus value DR-2026-05-22-a contemplates —
   multiple successful attempts per instance up to `N_target_successes`).
   Refund is useful.
2. The task's `claimWindowEnd` has passed. No new claims possible
   anyway. Refund is a no-op for the operator's economics on this
   task, but stays useful as a state-cleanliness signal (the on-chain
   `claimsByTaskByOperator` reflects the operator's actual outstanding
   exposure, which downstream indexers/dashboards can read).

**Recommendation:** refund unconditionally on expiry; do not gate on
finalisation status. The cases where refund is "useless" are also
cases where refund is "harmless" (no other operator can claim the slot
because the window is closed; the counter decrement is purely cosmetic
in that branch). Gating on finalisation adds complexity for zero
benefit.

There's a subtle interaction with the **multiple-successes-per-posting
shape** DR-2026-05-22-a contemplates: that DR explicitly accepts
"mild overshoot past N" from late verdicts, and the generator now
sizes `maxClaims = N - successful_count` at post time. If we refund
slots on expiry inside a posting that's already accumulated some
successes, the remaining live capacity could exceed `N - successful_count`
at certain timepoints. This is **fine** under the DR's "soft target"
framing — the per-posting `maxClaims` is already not a hard
trajectory cap (verdicts arrive asynchronously), and the refund only
recycles slots whose work never produced a verdict.

## 5. Interaction with related issues

**[#545 — Credit-readiness gate doesn't fire on resume]:** Composes
cleanly with Options A/B/C. The resume-readiness gap is independent of
the contract semantics decision. Even with Option A's refund, fixing
#545 reduces the rate of refundable expiries; even without Option A,
fixing #545 reduces slot loss. Recommend: ship #545 regardless of the
Option A/B decision.

**[#569 — `claim` vs `attempt` vocabulary unification]:** Touches the
same contract surface. The Stage 2 DR for #576 should at minimum **not
make the vocabulary worse** — its new function/event names (if any)
should follow whatever #569 lands, or explicitly defer to #569. A
modest preference: the refund event could be `TaskAttemptExpired`
(already exists) extended with a `refunded` field, or a new
`TaskAttemptRefunded` event. The latter is cleaner for indexer
filtering (Ponder can subscribe to just refund events without parsing
expiry-event fields) and doesn't break ABI invariance
(`contracts/test/jinn/upgrade/AbiInvariance.test.ts`) for the existing
event signature.

**[#562 — Safe nonce-too-low retry helper]:** Closed (merged 2026-05-25).
The interaction is positive: that fix reduces the rate of
"daemon-meant-to-call-expireAttempt-but-tx-dropped" scenarios under
Option A. No design coupling.

## 6. Recommendation

**Ship Option A (refund-on-expiry, contract change), plus the
per-window refund cap as the grief mitigation, plus fix #545 in
parallel.**

Specifically:
1. **Contract change.** `expireAttempt` decrements both
   `claimsByTaskByOperator[taskId][operator]` and `record.claimCount`
   when transitioning `Claimed | RequestRegistered → Expired`. No
   refund when the attempt has reached `Submitted` — the operator
   has committed an artifact to the network and pays the slot cost.
2. **Grief cap.** Add `mapping(uint256 => mapping(address => uint8))
   refundedClaimsByTaskByOperator` and a constant `MAX_REFUNDS_PER_OPERATOR_PER_TASK = 2`.
   `expireAttempt` increments this counter and reverts (or skips the
   decrement) once the operator has been refunded twice on this task.
   Two strikes — bad-luck recovery for honest operators, hard ceiling
   on adversary repeats.
3. **New event `TaskAttemptRefunded(taskId, attemptIndex, operator,
   newClaimCount, newOperatorClaimCount)`** emitted alongside
   `TaskAttemptExpired` when the refund branch fires. Enables clean
   indexer / operator-app accounting without ABI changes to existing
   events.
4. **Migration.** In-place implementation upgrade via the existing
   `upgrade-task-coordinator-router-v3.ts` script. No storage layout
   changes affecting existing slots (the new mapping appends a new
   storage slot; existing reads are byte-compatible). Bump version
   constant; add upgrade test under
   `contracts/test/jinn/upgrade/` confirming pre-upgrade state reads
   correctly post-upgrade.
5. **Operator-side helper.** Daemon emits a synthesised
   `expireAttempt` call from the engine's post-failure path
   (`canRunAfterClaim → failed` transition) so the refund lands
   without waiting for an external poke. Bounded by the cap, so a
   buggy daemon can't loop-grief itself.
6. **Issue #545 in parallel.** Independent fix, reduces the rate at
   which the refund path actually fires. Should be a separate PR
   under the same release branch.

**Residual risk:** an adversary can still deny up to
`2 × maxClaimsPerOperator × claimLeaseTtlSeconds` of denial-of-access
per task per posting — for swe-rebench-v2 today that's
`2 × 5 × 1 h = 10 h`. Within a 1-day `posting_window_ms`, that is a
~40% denial window. This is the cost we pay for not introducing a
bond mechanism in this DR. The DR should call this out and queue
"bond-and-slash for claim-slot grief" as a Phase B.2 design follow-up
(natural home — challenge-mechanism economics already lives there per
the Phase A umbrella mapping). The thin-operator network protects us
in the short term.

## 7. What the Stage 2 DR will need to say

Bullet list, in order, to make the DR drafting a writing-up exercise:

- **Verb.** `Steer` (semantics + migration). Mirror DR-2026-05-22-a's
  shape.
- **Context.** Restate Issue #576 in repo-grounded terms with the
  file:line citations from §1 of this note. Anchor to DR-2026-05-22-a
  as the task-level precedent; quote its "Contract finding — claim
  slots are a one-way budget" paragraph; state that this DR is the
  per-operator generalisation and that DR-2026-05-22-a's posting-level
  expiry heal does not cover the per-operator case (reposting rotates
  `taskId`, but per-task-per-operator counters do not reset *within*
  a posting).
- **Note.** `expireAttempt` is currently never invoked from anywhere
  outside Solidity tests — so today's status-quo is stricter than the
  contract allows. The decision needs to address activation of the
  expiry path as well as its semantics.
- **Decision.** Refund on expiry for `Claimed | RequestRegistered`
  transitions; no refund on `Submitted`. Cap refunds per
  (task, operator) at 2.
- **Implementation sketch.** The exact Solidity diff (§6 item 1) +
  the new mapping + the new event + a one-line decrement in
  `expireAttempt`. The daemon-side opportunistic call. Tests.
- **Migration.** UUPS in-place upgrade of the testnet proxy
  `0x9ce736d3CB367cC5Db538B7962bdf416EbD7451B` via
  `upgrade-task-coordinator-router-v3.ts`. No backfill of
  already-expired attempts (out of scope; testnet acceptable cost).
  Upgrade test under `contracts/test/jinn/upgrade/`.
- **Grief argument.** Walk through the §3 numbers. State plainly:
  the per-window cap converts indefinite repeat-grief into a bounded
  ~40% denial window per posting, accepted as the cost of no-bond.
  Defer bond-and-slash to Phase B.2.
- **Interaction with `requiredVerdicts`.** Refund unconditionally on
  expiry, do not gate on finalisation. State the recommendation and
  the §4 reasoning.
- **Interaction with #545 and #569.** Per §5. Specifically: the new
  event name `TaskAttemptRefunded` should be considered subject to
  the #569 vocabulary decision; if #569 lands first and chooses
  "attempt" as canonical, we're fine; if it chooses something else,
  rename.
- **Consequences.** New mapping = new storage slot (append-only, no
  layout break). Indexer should index `TaskAttemptRefunded` for the
  operator-app surface. Operator-app should surface the refund cap
  (`refunded 1 of 2` per task) so operators can plan around it.
- **Alternatives considered and rejected.** Option B (operator-side
  gates only) — rejected: doesn't cover daemon-crash mid-attempt and
  the existing-slot remediation is non-existent; gates fix the
  *rate*, not the *existence* of the failure. Option C.1
  (`Claimed`-only refund) — rejected: smaller surface but the
  `RequestRegistered → Expired` path is the more common operator
  failure shape (the mech request was posted but the agent crashed
  before delivery), and we lose those refunds. Option C.2 (cancel +
  bond) — deferred to bond-and-slash work in Phase B.2. Option D
  (status quo) — rejected on operator-economics + DR-2026-05-22-a's
  generator-sized caps making each lost slot more costly.
- **Status.** `Proposed` pending Captain review. Implementation is a
  follow-up `feat` issue (contract change, deployment, daemon helper,
  operator-app surface).

## Open questions for the human (escalate, do not block Stage 2 on these)

- **Bond mechanism timing.** Should we land bond-and-slash now under
  this DR, or defer to Phase B.2 as proposed? The proposal defers,
  trading a ~40% per-posting denial window for scope. Worth a
  one-line confirmation from Captain before Stage 2 ratifies.
- **Refund cap constant vs policy field.** `MAX_REFUNDS_PER_OPERATOR_PER_TASK = 2`
  as a contract constant is simplest; making it a field on
  `TaskPolicy` would let SolverNets tune it (e.g. session-derived's
  4-hour leases probably want a lower cap). YAGNI says constant;
  policy-field is cleaner long-term. Default to constant in the DR
  unless Captain prefers the field.
- **Backfill for already-burned slots.** Two slots on this operator's
  account are already lost on 2026-05-25. Stage 2 should decide
  whether to ship an owner-only one-shot backfill or accept the loss.
  Recommendation: accept the loss (testnet, minimal absolute cost,
  doesn't justify the migration code).
