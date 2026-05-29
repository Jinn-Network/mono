---
id: DR-2026-05-22-a
title: Task generation & claiming — generic generator knobs; swe-rebench-v2 = target-success cap, fill-the-pool, retry-on-expiry
date: 2026-05-22
verb: Steer
status: ratified
authors: opus (drafted on claude/issue-487-design), ritsukai (issue #487 author; ratifying Captain)
spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.6; amends DR-2026-05-06-i
---

## Context

GitHub issue [#487](https://github.com/Jinn-Network/mono/issues/487) flagged that
SWE-rebench-v2 task generation mixes three separate concepts without a clear
contract:

- **posting** — the generator creates a new on-chain Task for a benchmark instance;
- **claiming/solving** — operators pick up an already-posted Task and attempt it;
- **counting successes** — evaluator verdicts with `score === 1` count toward an
  instance's target.

DR-2026-05-06-i (P5) set the posting policy: full historical pool, post each
instance until `N_target_successes`, with a `cooldown_window` and an
`N_max_postings_per_task` cap. That DR's mental model implicitly assumed
**one posting ≈ one attempt ≈ one verdict** — under which `posted_count` is a
faithful proxy for an instance's memorisation surface.

That assumption does not hold against the shipped claim policy. The
`swe-rebench-v2` contract `claimPolicyDefaults` is `maxClaims: 50,
maxClaimsPerOperator: 5` (`packages/sdk/src/contracts.ts`), and
`TaskCoordinator.sol` enforces both per-Task on-chain. So **a single posting can
absorb 50 claims → up to 50 score=1 verdicts → 50 near-copy trajectories in the
corpus** — 10× past the `N_target_successes = 5` memorisation cap DR-i exists to
enforce.

The 2026-05-22 Phase 2 testnet run exposed two concrete failure modes:

1. **Under-posting.** `client/src/solver-types/swe-rebench-v2.ts:381-389` applies
   `cooldown_ms` *globally* — `Math.max(last_posted_at)` across the whole eligible
   pool blocks every poll if *any* instance was posted within `cooldown_ms`. The
   selector in `swe-rebench-v2-auto.ts:59` already applies cooldown per-instance;
   the global gate is a bug on top of it. The run posted exactly one task
   (`carsdotcom__skelebot-280`, id `157`) then idled for the full cooldown with a
   20-instance scorable pool available.

2. **Over-solving.** Per the claim-policy decoupling above, one posting yields up
   to 50 successes — far past N.

**Contract finding — claim slots are a one-way budget.** `TaskCoordinator.sol`
`claimTask` does `record.claimCount++` (line 345) and gates on
`claimCount >= maxClaims` (line 330). `expireAttempt` (lines 579-587) marks a
stale attempt `Expired` but **never decrements `claimCount`**. So every claim —
success, failure, or expired lease — permanently burns one of the `maxClaims`
slots; once the budget is spent the Task is permanently closed to new claims.
A posting is a fixed attempt budget that cannot self-heal.

**Generalisation.** Expiry and cooldown are not SWE-rebench-v2 facts — they are
generic task-generator knobs. Different SolverNets want different settings:
`prediction.v1` *must* expire (a Polymarket market resolves; a stale prediction
task is meaningless), whereas `swe-rebench-v2` instances are evergreen (a 2025-03
coding issue is just as valid to solve today). This DR defines the generic knobs
and pins `swe-rebench-v2`'s configuration.

DR-i §Consequences stated the subgraph would index per-task success counts "for
the generator's own consumption". The shipped generator instead counts successes
in a local `~/.jinn-client/swe-rebench-v2/generator-state.json`, incremented by
the delivery-watcher hook on witnessed verdicts.

This DR is the scoping output requested by issue #487; implementation is a
follow-up.

## Decision

> **Superseded in part by #802 (2026-05-28).** §Decision (4)–(6) below specified
> the swe-rebench-v2 repost trigger as *time-expiry* (`last_posted_at +
> posting_window_ms`), with an `N_max_postings_per_task` abandon cap. Issue #802
> promotes Option B (see §Alternatives): the repost trigger is now **claim-budget
> exhaustion** observed via the indexer (`getInstanceClaimCounts`), not the timer,
> and the abandon cap is removed (defaults to unbounded). `posting_window_ms`
> stays as each posting's on-chain claim-window deadline; only its role as the
> repost trigger is gone. Escrow reclaim remains out of scope (no refunds).

### Generic task-generator knobs

The task-generator framework exposes, configurable per SolverNet:

- **pool source** — how instances enter the generator (a static set, or a pool
  that grows; `swe-rebench-v2` grows ~50 instances/month).
- **time-expiry** — on/off + window length. It serves *two* roles: (a) the
  **repost trigger**, and (b) the **escrow-reclaim deadline** — `JinnRouterV3`
  escrows per-slot budget up front, and expiry returns escrow on unconsumed
  slots.
- **cooldown** — on/off + per-instance minimum spacing between postings.
- **target-success cap** `N_target_successes` — the universal stopping semantic.
- **attempt-budget policy** — how each posting's `maxClaims` is sized.

`swe-rebench-v2`'s configuration is pinned below; other SolverNets set their own.

### The semantics, configured for swe-rebench-v2

**1. `N_target_successes` is the single memorisation cap.** It counts score=1
verdicts per instance. When reached, the instance is *saturated* — retired from
posting, retained in the corpus. Every mechanism below exists only to respect it.

**2. Generator-sized claim caps.** The generator sets each posting's `maxClaims`
to the remaining budget `N_target_successes − successful_count` at post time, and
sets `maxClaimsPerOperator` **equal to it** — both derive from the same
remaining-success budget. `TaskCoordinator.sol` enforces `maxClaims` per-Task
on-chain, so the posting itself **hard-caps** the trajectories it can produce.
The flat `maxClaims: 50` / `maxClaimsPerOperator: 5` defaults are removed.

`maxClaimsPerOperator = maxClaims` means there is no per-operator sub-limit
*within* a posting — a single operator may take every slot. This is deliberate.
The memorisation cap is `N_target_successes`, enforced by `maxClaims` regardless
of *who* fills the slots; a per-operator sub-limit buys only *approach
diversity*, and only when enough operators exist. On a bootstrapping network a
sub-limit instead deadlocks loop closure — the 2026-05-08 single-operator
loop-closed run could not saturate an instance under any sub-limit `< maxClaims`.
`maxClaimsPerOperator` stays a launcher knob: a mature, multi-operator launched
instance can pin it below `maxClaims` to force approach diversity once operator
supply is healthy.

**3. Fill-the-pool posting, no cadence.** The generator posts a Task for *every*
scorable instance that is unposted and unsaturated, as fast as a per-tick batch
throttle (`post_batch_size`) allows, so operators have a full supply of work
immediately. There is no posting cadence, interval, or `cadenceMs`.

**4. Retry-on-expiry — and finite expiry is load-bearing.** There is exactly one
live posting per instance. Because the contract claim budget is one-way (slots
never recycle — see Context), a posting whose claims fail strands the instance
below N with no recovery *within that posting*. **Time-expiry is the heal:** when
a posting expires, the instance is reposted with a *fresh* `maxClaims =
N − successful_count` budget. Expiry → repost lets a stranded instance self-heal
using only local time state (`last_posted_at + posting_window_ms`) — no indexer
query. On expiry: if `posted_count ≥ N_max_postings_per_task` → **abandoned**
(retire); otherwise → **repost**.

**5. 1-day window; churn accepted.** The window is a launcher knob
`posting_window_ms` with default 1 d. On a thin operator set a 1-day window may
expire before N successes accumulate, producing reposting churn; and a verdict
landing just after expiry produces mild overshoot past N. Both are **accepted**
for simplicity — no post-expiry drain grace, no indexer-based in-flight
tracking. `N_target_successes` is a soft target.

**6. Cooldown removed for swe-rebench-v2.** With one-live-posting + repost-only-
after-expiry, the window length *is* the repost spacing. `cooldown` stays a
generic knob; `swe-rebench-v2` sets it off. The global cooldown gate
(`swe-rebench-v2.ts:381-389`) — the under-posting bug — is deleted.

**7. In-flight accounting — none for v1.** The expiry boundary serializes
postings per instance, so no concurrent in-flight attempts race a new posting.
The residual overshoot (a verdict landing just after expiry) is accepted per (5).
v1 keeps the local `generator-state.json` ledger (`posted`, `successful`,
`last_posted_at` is the complete state the generator needs). Migrating
success counts to the subgraph — the canonical network-wide source DR-i
§Consequences named — is a scoped follow-up for when multi-daemon evaluation
makes the local ledger under-count.

### Parameters after this DR (swe-rebench-v2)

| Parameter | Before | After | Meaning |
|---|---|---|---|
| `N_target_successes` | 3 | 5 | memorisation cap — score=1 verdicts per instance before retire |
| `N_max_postings_per_task` | 10 | 10 | impossible-task cap — abandon after this many postings without N |
| `posting_window_ms` | 7 d (hardcoded) | 1 d (launcher knob, default 1 d) | time-expiry window; repost trigger + escrow-reclaim deadline |
| `cooldown_ms` | 24 h | **removed** | generic knob; off for swe-rebench-v2 |
| `post_batch_size` | — | ≈ 25 | max Tasks posted per tick (chain-hammer throttle, not cadence) |
| `maxClaims` (per posting) | 50 (flat) | `N − successful_count` (derived) | the posting is the capacity unit |
| `maxClaimsPerOperator` (per posting) | 5 (flat) | `= maxClaims` (derived) | no per-operator sub-limit; launcher-tightenable |

`N_target_successes`, `N_max_postings_per_task`, `posting_window_ms`,
`post_batch_size` are launcher-set in the manifest. `maxClaimsPerOperator` may be
optionally pinned in the manifest *below* the derived `maxClaims` value to force
approach diversity; absent that, it derives.

## Rationale

- **Generator-sized caps make the posting the unit of capacity.** The on-chain
  `TaskCoordinator` enforces the per-posting cap for free; zero in-posting
  overshoot by construction; no live claim-state query needed.
- **Finite expiry is not optional plumbing.** It is the only mechanism that
  resets the one-way claim budget. "No expiry" + non-recycling slots = stranded
  instances with no recovery path short of an indexer-driven capacity check.
  Keeping a finite 1-day window keeps the heal local and time-based, and keeps escrow
  reclaiming on dead slots.
- **1 day over a longer window — faster retry.** A longer window would reduce
  churn but delays saturation. The issue author chose a 1 d default and accepts
  the repost churn.
- **Fill-the-pool matches DR-i's own reasoning.** DR-i argued the full
  ~750-instance pool gives bootstrap surface and compounding corpus value;
  posting it all now delivers that, a trickle does not.
- **`maxClaimsPerOperator` derives `= maxClaims`, not a fixed sub-limit.** The
  load-bearing cap is `N_target_successes`; *who* fills the N slots does not
  change the corpus's trajectory count. A per-operator sub-limit adds approach
  diversity only when operators are plentiful, and on a thin network blocks the
  loop from closing. Diversity is better pursued through real network growth; the
  knob remains for launchers that have the operator supply to use it.

## Alternatives considered and rejected

- **Keep `maxClaims: 50` flat / the current design.** Rejected — this is the
  over-solving + under-posting bug.
- **No time-expiry, single posting, over-provisioned `maxClaims`** (Option A
  from the design session). Rejected: a fixed attempt budget either strands hard
  instances (budget too low) or overshoots easy ones (too high); reposting
  adapts the budget per instance. Also locks escrow on unconsumed slots
  indefinitely.
- **No time-expiry, repost on claim-exhaustion via an indexer query** (Option B).
  Deferred: gives exact-N with zero overshoot but makes the generator depend on
  the indexer. Kept as the generic framework's option for SolverNets that want an
  exact-N guarantee; not used by `swe-rebench-v2` v1.
- **`maxClaimsPerOperator = 1` (strict per-operator diversity) as the default.**
  Rejected: it requires N distinct operators to saturate any instance and
  deadlocks loop closure on a single-/thin-operator network (cf. the 2026-05-08
  single-operator loop-closed run). Retained only as an opt-in launcher knob.
- **Lengthen the window to ~30-90 d.** Rejected for simplicity — issue author
  chose 1 d + accept churn.
- **A `repost_drain_ms` grace after expiry.** Dropped — "accept the churn"
  subsumes the late-verdict overshoot the grace was there to prevent.
- **Source success counts from the subgraph now.** Deferred — correct per DR-i
  §Consequences, but unnecessary for a single-launcher testnet.

## Consequences

- **DR-2026-05-06-i is amended.** Its `cooldown_window` and per-task posting-loop
  framing are superseded. The core P5 choice stands: full historical pool,
  `N_target_successes` as the memorisation cap, `N_max_postings_per_task` as the
  impossible-task cap.
- **Spec §3.6** of `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md`
  is rewritten to swe-rebench-v2's configuration, with a generic
  **Task-generator framework** vocabulary sub-section (pool source, time-expiry,
  cooldown, target-success cap, attempt-budget). A standalone spec doc is not
  created — the framework is two generators wide today; revisit if it grows.
- **Implementation follow-up** (a `refactor`-shape issue): delete the global
  cooldown gate; expose `time-expiry`/`cooldown` as generic per-SolverNet
  generator knobs; `GeneratorConfig` drops `cooldown_ms`, adds
  `posting_window_ms` (default 1 d) and `post_batch_size`;
  `selectNextPostingCandidate` becomes a batch selector returning up to
  `post_batch_size` instances (`tick` already returns `Task | Task[] | null`);
  the generator sets per-posting `maxClaims = N − successful_count` and
  `maxClaimsPerOperator = maxClaims`; the deadline derives from
  `posting_window_ms`; live/expired state derives from
  `last_posted_at + posting_window_ms`; the `swe-rebench-v2` contract
  `claimPolicyDefaults` static fallback becomes
  `maxClaims = maxClaimsPerOperator = N_target_successes` (the generator
  overrides both per posting); the manifest schema gains `posting_window_ms` /
  `post_batch_size` / an optional `maxClaimsPerOperator` override and drops
  `cooldown_ms`; regression tests cover both failure modes (one post must not
  stall the pool; one posting must not exceed N claims).
- **Operator app surface.** The generator is a *launcher* concern.
  `client/OPERATOR-APP-SPEC.md` §2.13 lists **Launcher** as an optional component
  that is still a stub ("fully specified in its own follow-up when activated"),
  so the generator has no spec'd surface today — while
  `LauncherGeneratorStateSnapshot` and the launcher SPA pages already ship ahead
  of the spec. This DR forces that follow-up (a canonical-doc change —
  CODEOWNERS + Discussion): the §2.13 Launcher component needs its four-axis
  spec, and its generator surface must reflect the post-DR model — drop
  `cadenceMs` (no cadence; `launched-record-dispatcher.ts:155` projects it
  today), and replace the cooldown-gated `lastPollSummary.skipped` with
  fill-the-pool / saturation progress (pool size; instance counts by state:
  `unposted` / `live` / `saturated` / `abandoned`). The solver-side surfaces
  (§2.4 Memberships, §2.5 Registry, §2.6 Tasks, §2.10 `claim_available` /
  `claim_failed`) already model claiming and need no change — generator-sized
  `maxClaims` only means a posting reaches fully-claimed sooner, which the
  existing discovery filter (`http.ts:619`) already handles.
  repost several times (up to `N_max_postings_per_task`) before it saturates;
  escrow churns per posting; mild overshoot past N can occur from verdicts that
  land just after expiry. This is the accepted cost of the 1-day window with no
  in-flight tracking.
- **Thin-operator testnet.** Because `maxClaimsPerOperator = maxClaims`, a single
  operator can saturate an instance on its own — the loop closes with any
  operator count ≥ 1, and no manifest workaround is needed at low operator
  counts. A launcher that later wants enforced approach diversity pins
  `maxClaimsPerOperator` below `maxClaims` once operator supply supports it.
- **Spend.** Posting cost scales with `maxClaims` (`JinnRouterV3` escrows
  `solutionBudget = solutionMaxDeliveryRate × maxClaims`). Dropping `maxClaims`
  from 50 to ≤ N = 5 is ~10× cheaper per posting; the 1-day expiry reclaims
  escrow on unconsumed slots.

## Status

Ratified by Captain ritsukai on 2026-05-22 after review of issue #487, the
proposed DR in PR #488, and the follow-up implementation plan. Drafted on
`claude/issue-487-design` in a from-first-principles design session with the
issue author.

## Amendment 2026-05-29 (fix #850) — restore window-expiry as a repost trigger

#802 (Option B) made claim-budget exhaustion the sole repost trigger and removed
the time-window trigger (AC#5: "each posting keeps its normal on-chain
claim-window deadline unchanged"), on the implicit assumption that a posting
always leaves the claimable set by exhaustion. It does not. `TaskCoordinator`
enforces a finite on-chain claim window, and once it closes (`block.timestamp >
claimWindowEnd`), `claimTask` reverts `TCClaimWindowClosed`
(`contracts/src/tasks/TaskCoordinator.sol:328`) — but window-expiry is **not** an
on-chain event or state change: no event fires, no flag flips, `claimCount` is
untouched, and `getInstanceClaimCounts` does not even fetch `claimWindowEnd`. So
a posting whose window closes with slots still unconsumed becomes permanently
unclaimable yet can never reach exhaustion, stranding `live` forever (observed on
service 46: 96 stranded, `repostable: 0`, launcher silent, M1 blocked).

`classifyPoolTask` now reposts on **exhaustion OR window-expiry**:
`repostable ⟺ not saturated AND (consumed ≥ maxClaims OR now − last_posted_at ≥ posting_window_ms)`.
Exhaustion keeps #802's fast event-driven path on a busy network; the expiry
clause is a **local-time backstop** (the chain emits no expiry signal, so it must
be computed from `last_posted_at + posting_window_ms`) that heals a thin or
stalled network. This partially supersedes #802 AC#5 — the time trigger returns
as a backstop, not the primary path. The escrow-reclaim / refund concern stays
out of scope (`refundUnusedTaskBudget` remains dormant; the one-way claim budget
is untouched). See issue #850.
