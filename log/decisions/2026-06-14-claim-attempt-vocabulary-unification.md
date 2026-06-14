---
id: DR-2026-06-14
title: Unify claim vs attempt vocabulary — claim is the act, attempt is the record
date: 2026-06-14
verb: Steer
status: proposed
authors: claude (drafted on design/569-unify-claim-vs-attempt-vocabulary-across-contract-generator)
relates-to: issue #569, issue #576, DR-2026-05-22-a, DR-2026-05-25
---

## Context

`claim` and `attempt` are used inconsistently across four surfaces — the
`TaskCoordinator` contract, the swe-rebench-v2 generator, the harness engine,
and the operator dashboard — and the inconsistency teaches operators wrong
mental models.

The trigger (issue #569): an operator read `N_target_successes: 5` in a
generator config as "any operator can keep claiming until 5 attempts succeed",
when in fact `maxClaimsPerOperator` is the *per-task, per-operator* quota
enforced on-chain (`TaskCoordinator.claimsByTaskByOperator`, line 170), and
that counter increments on **every** `claimTask` call with **no** decrement on
expiry. The two numbers live on different axes — one is a launcher-side
lifetime saturation target, the other is an on-chain anti-Sybil quota — but
both surface near the word "claim" in the UI, so operators conflate them.

The no-decrement-on-expiry property is not an accident. DR-2026-05-25
considered refunding the per-operator claim quota on attempt expiry and was
**rejected** precisely to preserve "claim = permanent commitment": every claim
costs a slot regardless of outcome, which is the anti-Sybil mechanism that
makes claiming meaningful. So the operator's surprise is the surprise of a
correctly-designed but under-explained mechanism, not of a bug.

The deeper problem is that the words themselves are doing two jobs at once and
nobody wrote down which job is which:

- `claim*` names appear on counters (`claimCount`, `claimsByTaskByOperator`,
  `maxClaims`, `maxClaimsPerOperator`), on a function (`claimTask`), on a
  status (`AttemptStatus.Claimed`), and — confusingly — on two *unrelated*
  subsystems (delivery settlement `claimDelivery`, JINN-reward distribution
  `JinnClaimLoop` / `claim_available`).
- `attempt*` names appear on the on-chain record (`AttemptRecord`,
  `attemptIndex`, `_attempts[taskId][attemptIndex]`, the whole `AttemptStatus`
  lifecycle) — *and also* on a generator field, `attemptNumber`
  (`client/src/types/task.ts`, `client/src/tasks/posting-service.ts`), which
  actually counts something else entirely: repost cycles.

This DR resolves the vocabulary, fixes the one genuine collision, disambiguates
the three "claim" subsystems, and writes down the gloss so the next operator
does not have to reverse-engineer it from storage layout.

This builds directly on DR-2026-05-22-a, which already established
posting / claiming-solving / counting-successes as three distinct concepts in
the swe-rebench-v2 generator. This DR extends that separation across the whole
stack and gives each concept a canonical name.

## Decision

Ratify the existing verb/noun split as canonical. Do **not** collapse "claim"
and "attempt" into one word.

- **`claim` is the verb — the *act*.** An operator reserving one solution slot
  on a posted Task by calling `claimTask`. Each claim permanently consumes a
  slot regardless of outcome (the anti-Sybil commitment affirmed by
  DR-2026-05-25). Every counter that counts *acts* keeps its `claim*` name:
  `claimCount`, `claimsByTaskByOperator`, `maxClaims`, `maxClaimsPerOperator`,
  `claimLeaseTtlSeconds`, `claimWindowStart`/`claimWindowEnd`.

- **`attempt` is the noun — the resulting *record*.** The `AttemptRecord` a
  claim creates, stored at `attemptIndex` in `_attempts[taskId][attemptIndex]`,
  moving through the `AttemptStatus` lifecycle
  (`Claimed → RequestRegistered → Submitted → …`).

One `claimTask()` call creates exactly one `AttemptRecord`, so
`claimCount == number of AttemptRecords`. **`claim` and `attempt` are the verb
and the noun of one event, not two synonyms for one concept.** The fix is to
make that split legible and apply it consistently — not to rename half of it.

Because the deployed contract *already* follows this split, this is the
minimum-churn option: **no contract migration is required.** The deployed
names are correct and are grandfathered with a documenting natspec comment.

Three real changes follow from the decision, beyond writing down the gloss:

1. **Rename the off-chain `attemptNumber` collision to `postingNumber`.** In
   the generator/posting path, `attemptNumber` does not count contract attempt
   slots — it counts repost cycles (which posting iteration this is: 1st, 2nd,
   …). That is the **posting** axis. It must not borrow the contract's noun.

2. **Rule that unqualified "claim" means task-slot reservation.** The two other
   subsystems that say "claim" — delivery settlement and JINN-reward
   distribution — must always be qualified.

3. **Add operator-facing helper text** distinguishing `maxClaimsPerOperator`
   (the on-chain per-task quota) from `N_target_successes` (the launcher
   lifetime success target), which is the exact confusion that triggered #569.

## Rationale

Collapsing to one word destroys information. A claim and the attempt it creates
are genuinely different things in the data model: one is an event that
increments a counter and can fail to produce a useful solution; the other is a
durable row with a lifecycle and an index. We routinely need to say both "how
many times was this slot claimed" (`claimCount`) and "what is the status of
attempt #2" (`_attempts[taskId][2].status`). A single word would force one of
those two statements to be expressed awkwardly.

The split is also already load-bearing on-chain and in the indexer. Keeping it
means zero contract churn, zero ABI change, zero indexer schema migration. The
cost of the inconsistency is entirely pedagogical — operators don't have the
gloss — and the cheapest fix for a pedagogical problem is to write the gloss
down and remove the one genuinely misleading reuse, not to re-deploy a contract.

The anti-Sybil framing seals it: "claim" *should* feel like a commitment verb.
Renaming it to "attempt" or "submission" would soften exactly the connotation
DR-2026-05-25 fought to preserve.

## The vocabulary map

| Term | Canonical gloss | Part of speech |
|---|---|---|
| **claim** | An operator reserving one solution slot on a posted Task (`claimTask`). Permanently consumes a slot regardless of outcome (anti-Sybil commitment). | verb / act |
| **attempt** | The `AttemptRecord` a claim creates, at `attemptIndex`, moving through `AttemptStatus`. | noun / record |
| **claimCount** | Number of claims taken on a Task = number of `AttemptRecord`s created. | counter (of acts) |
| **maxClaims** | Task-wide cap on total claims. | quota |
| **maxClaimsPerOperator** | Per-task, per-operator cap on claims. The on-chain anti-Sybil quota. NOT the launcher success target. | quota |
| **claimLeaseTtlSeconds** | How long a claimed (but un-submitted) slot stays leased before it can be expired. | duration |
| **claimWindowStart / claimWindowEnd** | The on-chain window during which `claimTask` is accepted. | bound |
| **posting / postingNumber** | Launcher-side count of how many times a Task was posted to chain (repost cycle index). The posting axis. NOT a contract attempt slot. | counter (of posts) |
| **successful** | An attempt whose verdict passed. The `N_target_successes` saturation axis. | qualifier |
| **verdict** | The evaluator's output on an attempt (`VerdictRecord` / `VerdictStatus` / `recordVerdict`). | noun / record |
| **delivery** | The solution-submission step of an attempt (`claimDelivery` / `recordSubmission` / `AttemptStatus.Submitted`). Always qualified — never bare "claim". | step |
| **JINN claim / reward claim** | Operator collecting distributed JINN rewards (`JinnClaimLoop` / `JinnDistributor.claim`). Always qualified — never bare "claim". | step (distinct subsystem) |

## Rename / grandfather / annotate steps

Grouped by surface. Each step is tagged `[rename]` (off-chain identifier
change), `[grandfather+comment]` (keep the deployed/load-bearing name, add a
documenting comment), or `[add-helper-text]` (UI copy only).

### Contract — `contracts/src/tasks/TaskCoordinator.sol`

- `[grandfather+comment]` All deployed `claim*` and `Attempt*` names stand
  unchanged: the enums `AttemptStatus` (57), `AttemptFinalization` (65); the
  `TaskPolicy` fields `claimWindowStart`/`claimWindowEnd`/`claimLeaseTtlSeconds`/
  `maxClaims`/`maxClaimsPerOperator` (96–101); `TaskRecord.claimCount` (112);
  the `AttemptRecord` struct (118) with `attemptIndex` (120) /
  `claimedAt` (125) / `claimExpiresAt` (126); storage `_attempts` (168) and
  `claimsByTaskByOperator` (170); `claimTask` (316, returns
  `(attemptIndex, claimExpiresAt)`); events `TaskClaimed` (190) /
  `TaskAttemptExpired` (238); the `TCMaxClaimsReached` (21) /
  `TCOperatorClaimLimitReached` (22) / `TCAttempt*` (24–35) error family.
- `[grandfather+comment]` Update the title natspec, line 47–48
  ("Canonical Task lifecycle, claim, attempt, submission, and evaluation
  state…"), to state the canonical split explicitly: *claim is the act
  (`claimTask`), attempt is the record (`AttemptRecord`); `claimCount` counts
  acts and equals the number of attempts.* This is the on-chain anchor for the
  gloss. No storage, signature, or ABI change.

### Contract TS mirror — `client/src/adapters/mech/contracts.ts`

- `[grandfather+comment]` ABI / typed-interface fields mirror the contract and
  stay: `maxClaims` (61, 355), `maxClaimsPerOperator` (62, 356),
  `claimCount` (77), `claimTask` (367, returns `{taskId, attemptIndex,
  requestId}`), `attemptIndex` (375, 412). Add a one-line comment pointing at
  this DR for the verb/noun split.

### Generator / solver-types

- `[grandfather+comment]` `client/src/solver-types/_swe-rebench-v2-state.ts`:
  `TaskCounters.posted` (14) / `recordPosted` (87) and `.successful` (15) /
  `recordSuccess` (96) are already on the correct (posting / success) axes per
  DR-2026-05-22-a — keep, and add a comment that `posted` is the posting axis,
  distinct from contract `claimCount`.
- `[grandfather+comment]` `client/src/solver-types/swe-rebench-v2-auto.ts`:
  `N_target_successes` (14), `maxClaimsPerOperator` (17),
  `claimLeaseTtlSeconds` (18), `InstanceClaimSnapshot.consumed`/`maxClaims`
  (55–56), `SelectArgs.claimCounts` (66) are correctly named — keep. Add a
  comment on `N_target_successes` that it is the launcher lifetime success
  target, NOT `maxClaimsPerOperator`.
- `[grandfather+comment]` `client/src/solver-types/swe-rebench-v2.ts`: the
  deprecated `maxClaims` (87) / `maxClaimsPerOperator` (90), `claimCounts`
  (758), and `posted_count_after_record` (855) keep their names.

### Harness engine

- `[grandfather+comment]` `client/src/harnesses/engine/state.ts`:
  `TaskRunState.CLAIMED` (13) and `DELIVERING` (19) stay. Annotate that
  `CLAIMED` is the task-slot-reservation sense and `DELIVERING` is the
  *delivery-settlement* sense (`claimDelivery`), a distinct subsystem.
- `[grandfather+comment]` `client/src/harnesses/engine/persistence.ts`: the SQL
  column `attempt_index` (47, 324) and `PersistedTaskRun.attemptIndex`
  (131, 156, 389) mirror the contract `attemptIndex` — keep.
- `[grandfather+comment]` `client/src/harnesses/engine/engine.ts`: `claim()`
  (805, DISCOVERED→CLAIMED), `releaseClaimedNotStarted` (834),
  `claimDeliveryVariant` (1633), and the `JinnRouter.claimDelivery` reference
  (1763) keep their names; `claimDelivery*` is the qualified delivery sense.
- `[grandfather+comment]` `client/src/harnesses/types.ts`: the `canAttempt`
  Harness method (260) and its implementations (legacy-claude/index.ts:73,
  prediction-v1-baseline/index.ts:36, prediction-v0-baseline/index.ts:65,
  prediction-apy-v0-baseline/index.ts:65, prediction-v1-evaluator/index.ts:60)
  read on the attempt axis ("can this impl attempt this task") — keep.

### Dashboard / UI

- `[add-helper-text]` `client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.tsx`:
  keep the `maxClaimsPerOperator` field (58, 89–90), the labels "Claim policy"
  (559) / "Max claims per operator" (565) / "Claim lease (seconds)" (573). Add
  helper text under "Max claims per operator": *"on-chain per-operator quota
  for this task; distinct from the lifetime success target
  (`N_target_successes`)."*
- `[add-helper-text]` `client/src/dashboard/spa/src/pages/launcher-create/Step3ConfigureGenerator.tsx`:
  keep `maxClaimsPerOperator` (380) / `claimLeaseTtlSeconds` (381) and labels;
  the existing helper "How long a claimed SWE task slot stays leased." (568)
  and "On-chain claim-window deadline for each posting." (523) stay. Add the
  same `maxClaimsPerOperator`-vs-`N_target_successes` clarifier next to the
  "Max claims per operator" label (552).
- `[add-helper-text]` `client/src/dashboard/spa/src/pages/launcher-create/Step4ConfigurePricing.tsx`:
  keep `maxClaimsPerOperator` (163) and hints (191, 280). No rename.
- `[grandfather+comment]` `client/src/dashboard/spa/src/pages/launcher-create/templates.ts`:
  `ClaimPolicyDefaults` / `GeneratorDefaults` field names (54–55, 88) and the
  default values (maxClaims:25/perOperator:1 at 151–152;
  maxClaims:5/perOperator:5 at 228–229) stay.
- `[add-helper-text]` Any "Claims" counter rendered as `4/5 claims` /
  `3/4 claims` is numerically correct (claim-count = attempt-count of the
  per-operator quota). Do NOT rename it. Add a tooltip: *"claims taken of the
  per-operator quota"*.
- `[grandfather+comment]` `client/src/dashboard/spa/src/pages/overview/ActivityCard.tsx`:
  `ACTIVE_STATES` includes `'CLAIMED'` (110) and the comment "successfully
  claimed the run" (62) — keep; this is the task-slot sense.
- `[rename]` (low-priority UI follow-up, not a contract change)
  `client/src/dashboard/spa/src/notifications/taxonomy.ts`: `'claim_available'`
  (13) is a **JINN-reward** event while `'claim_failed'` (14) is a
  **task-slot** event — two different "claim"s in one taxonomy. Move the reward
  kind toward reward wording (e.g. `reward_available`) so the operator never
  sees bare "claim" meaning two things. Keep `claim_failed` (task-slot sense).
- `[rename]` (same follow-up)
  `client/src/dashboard/spa/src/lib/event-kinds.ts`: the labels "Testnet JINN
  claim emitted" (73) / "Testnet JINN claim submitted" (83) describe reward
  distribution — re-word toward "reward" so they read as the qualified JINN
  sense, not the bare task-slot sense. "A claim or evaluation lost the on-chain
  race" (104) is the task-slot sense — keep, optionally tightened to "A task
  claim or evaluation claim lost the on-chain race".

### Types / adapters — the `attemptNumber` collision (the one genuine rename)

- `[rename]` `client/src/types/task.ts`: rename the Zod field `attemptNumber`
  (43) and its type occurrences (83, 101, 128) to **`postingNumber`**. The
  comment "JinnRouterV3.createTask / claimTask" (163) stays.
- `[rename]` `client/src/tasks/posting-service.ts`: rename `attemptNumber`
  (19, 109, 115, 141, 149, 170, 171, 179, 181) to `postingNumber`; it is
  derived from `postCount` (line 108–109: `previousPostCount + 1`), so it is
  the posting axis. Rename the derived `attemptId = "${taskId}/${attemptNumber}"`
  (110, 171) to `postingId = "${taskId}/${postingNumber}"`.
- `[grandfather+comment]` `client/src/adapters/mech/adapter.ts`: the contract
  `attemptIndex` reads (80, 235, 407, 413, 476, 510, 516, 525, 749, 756, 974,
  1018, 1033, 1173, 1203) stay — they mirror the on-chain noun. The one line
  that maps contract `attemptIndex` → a Task field named `attemptNumber`
  (760) must be updated to feed `postingNumber` only if the Task field it
  targets is the posting-axis field; if the value is genuinely the contract
  `attemptIndex`, the Task field it writes to should be a contract-aligned
  `attemptIndex`, not the posting `postingNumber`. The implementer must
  disambiguate at the call site (this is the heart of the collision: one line
  silently aliased the two axes). `claimEvaluation` (1228–1242) and the log
  `…/task/${taskId}/${attemptIndex}` (476) stay.
- `[grandfather+comment]` `client/src/adapters/local/adapter.ts`: `claimCounts`
  (19) and `attemptIndex` (77–78) mirror the contract — keep.
- `[grandfather+comment]` `client/src/discovery/http.ts`: GraphQL
  `orderBy: "attemptIndex"` (114, 251) and the response field `attemptIndex`
  (120, 430) mirror the indexer schema, which mirrors the contract — keep.
- `[grandfather+comment]` `client/src/types/task-document.ts`:
  `TaskClaimPolicy.maxClaimsPerOperator` (31) — keep.

## Backwards-compatibility (deployed contracts)

The deployed on-chain function, event, storage, enum, and error names are
**grandfathered unchanged**. The split this DR ratifies is *already* the
on-chain reality, so there is nothing to migrate:

- `claimTask`, `registerAttemptRequest`, `recordSubmission`, `claimEvaluation`,
  `recordVerdict`, `expireAttempt`, `getAttempt` — signatures unchanged.
- `AttemptStatus`, `AttemptFinalization`, `VerdictStatus`, `VerdictCode` —
  enum names and members unchanged.
- `_attempts`, `claimsByTaskByOperator`, `claimCount`, `attemptIndex`,
  `maxClaims`, `maxClaimsPerOperator` — storage layout unchanged (UUPS-safe;
  no slot moves).
- `TaskClaimed`, `TaskAttemptExpired`, `TaskAttemptRequestRegistered`,
  `TaskSubmitted`, and the `TC*` error family — ABI unchanged.

The only contract-side change is a documenting natspec comment (title line 48)
recording the gloss. **No migration, no re-deploy, no ABI change is required
by this DR.** If a future contract version is cut for unrelated reasons, it
**keeps** these names; the verb/noun split is canonical going forward.

This also resolves the open question DR-2026-05-25 left at lines 298–303: that
DR's `TaskAttemptRefunded` event name follows the `TaskAttempt*` family and
asked to be revisited "if #569 ratifies a different canonical noun." #569
ratifies the **same** noun (`attempt` for the record), so the `TaskAttempt*`
family name stands and DR-2026-05-25's naming needs no follow-up rename (its
*mechanism* remains rejected on its own merits, independent of this DR).

## Adjacent terms that stay distinct

These are NOT synonyms for claim/attempt and must keep their own names:

- **posted / posting** — the launcher's count of how many times a Task was
  posted to chain (repost cycle). Carried by `posted` / `recordPosted` /
  `last_posted_at` / `postCount` and, after this DR, the off-chain
  `postingNumber`. The posting axis. Distinct from `claimCount`.
- **successful** — attempts whose verdict passed; the saturation axis that
  `N_target_successes` counts down. Distinct from "claimed" (an attempt can be
  claimed and never become successful).
- **verdict** — the evaluator's output on an attempt: `VerdictRecord`,
  `VerdictStatus`, `recordVerdict`. Distinct from the attempt it evaluates.
- **delivery** — the solution-submission step of an attempt:
  `JinnRouter.claimDelivery`, `recordSubmission`, `AttemptStatus.Submitted`,
  engine `DELIVERING`. Always qualified as "delivery"; "claim" here is the
  settlement subsystem, never bare task-slot claim.

## Consequences

- **No contract churn.** Zero migration, zero ABI change, zero indexer schema
  change. The on-chain split is the canonical split.
- **One narrow off-chain rename** (`attemptNumber → postingNumber`) removes the
  single genuinely misleading reuse and forces the adapter call site
  (`adapter.ts:760`) to disambiguate the posting axis from the contract
  attempt-index axis.
- **Operator confusion at the trigger point is addressed directly** by helper
  text separating `maxClaimsPerOperator` (on-chain per-task quota) from
  `N_target_successes` (launcher lifetime success target).
- **The dashboard stops showing "claim" for two different things** once the
  reward-notification re-wording lands.
- **Follow-up implementation issues this DR should spawn:**
  1. A `refactor` issue: off-chain rename `attemptNumber → postingNumber`
     across `client/src/types/task.ts`, `client/src/tasks/posting-service.ts`,
     and the `adapter.ts:760` mapping (with the call-site disambiguation),
     plus the grandfather comments on the contract title natspec and the TS
     ABI mirror. Integration-tested against the posting path.
  2. A `feat`/`docs` issue: UI helper text + reward-label disambiguation —
     the `maxClaimsPerOperator`-vs-`N_target_successes` clarifiers, the
     `4/5 claims` tooltip, and the `claim_available → reward_available`
     notification-kind / event-label re-wording.
- **GLOSSARY.md** should gain entries for `claim` (verb), `attempt` (noun),
  `posting`, and the qualified `claim` subsystems (delivery claim, JINN
  reward claim), per the canonical-doc process — folded into follow-up (2).

## Alternatives considered and rejected

- **Collapse everything to "claim".** Loses the noun. We still need a name for
  the durable record with an index and a lifecycle; "claim" as a noun would
  collide with "claim" as the act, and "the third claim's claim status" is
  nonsense. Also strands the on-chain `AttemptRecord` / `attemptIndex` /
  `AttemptStatus` family, forcing exactly the contract migration this DR avoids.

- **Collapse everything to "attempt".** Loses the verb's anti-Sybil
  connotation. "Attempting a task" reads as soft and free-to-retry; DR-2026-05-25
  rejected refund-on-expiry specifically to keep the action feeling like a
  permanent commitment. Renaming `claimTask`/`maxClaimsPerOperator` to
  `attempt*` would soften the one word that must stay sharp, and again triggers
  a contract migration for no data-model gain.

- **Collapse everything to "submission".** Worst of the three: "submission"
  already names a *different, later* step — `recordSubmission` /
  `AttemptStatus.Submitted` / the `submittedCount` counter — the point at which
  an operator delivers a solution for an attempt they already claimed.
  Overloading it onto the reservation act would merge two genuinely distinct
  lifecycle stages (reserve vs. deliver) into one word and break the existing
  `Claimed → … → Submitted` status progression.

The verb/noun split keeps both the act and the record nameable, keeps the
anti-Sybil connotation on the verb, preserves the distinct "submission" step,
and costs no contract change. It wins on information preserved per unit of
churn.

## Status

`proposed`. Awaiting Captain ratification. On ratification, this DR spawns the
two follow-up issues named under Consequences (one `refactor`, one
`feat`/`docs`) and the GLOSSARY.md entries; no contract work is gated on it.
