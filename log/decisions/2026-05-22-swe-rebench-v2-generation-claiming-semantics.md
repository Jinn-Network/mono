---
id: DR-2026-05-22-a
title: SWE-rebench v2 generation & claiming — fill-the-pool posting, generator-sized claim caps, retry-on-expiry
date: 2026-05-22
verb: Steer
status: proposed
authors: opus (drafted on claude/issue-487-design), ritsukai (issue #487 author)
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
corpus** — 16× past the `N_target_successes = 3` memorisation cap DR-i exists to
enforce. Posting-count and the memorisation cap are decoupled by the claim
policy.

The 2026-05-22 Phase 2 testnet run exposed two concrete failure modes:

1. **Under-posting.** `client/src/solver-types/swe-rebench-v2.ts:381-389` applies
   `cooldown_ms` *globally* — it takes `Math.max(last_posted_at)` across the whole
   eligible pool and blocks every poll if *any* instance was posted within
   `cooldown_ms`. The selector in `swe-rebench-v2-auto.ts:59` already applies
   cooldown correctly per-instance; the global gate is a bug on top of it. The
   run posted exactly one task (`carsdotcom__skelebot-280`, id `157`) then idled
   for the full cooldown with a 20-instance scorable pool available.

2. **Over-solving.** Per the claim-policy decoupling above, one posting yields up
   to 50 successes — the corpus accumulates far more than N trajectories for an
   instance even though the generator never reposts it.

DR-i §Consequences stated the subgraph would index per-task success counts
"for the generator's own consumption". The shipped generator instead counts
successes in a local `~/.jinn-client/swe-rebench-v2/generator-state.json`,
incremented by the delivery-watcher hook on verdicts the daemon witnesses. For a
single-launcher testnet this is adequate; it is not the network-wide source DR-i
named.

This DR defines the intended protocol semantics for SWE-rebench-v2 generation
and claiming. It is the scoping output requested by issue #487; implementation is
a follow-up.

## Decision

**`N_target_successes` is the single memorisation cap.** It counts score=1
verdicts per instance, network-wide in intent. When reached, the instance is
*saturated* — retired from posting, retained in the corpus. Every other mechanism
below exists only to respect this cap.

### 1. Generator-sized claim caps

The generator sets each posting's `maxClaims` to the **remaining budget**
`N_target_successes − successful_count` at post time, and `maxClaimsPerOperator =
1`. Because `TaskCoordinator.sol` enforces `maxClaims` per-Task on-chain, the
posted Task itself **hard-caps** how many trajectories that posting can produce —
the fix is an on-chain guarantee, not a soft generator check. The flat
`maxClaims: 50` default is removed; the `swe-rebench-v2` contract
`maxClaimsPerOperator` default changes `5 → 1`.

`maxClaimsPerOperator = 1` ensures the N successes come from N *distinct*
operators — the approach diversity DR-i wants ("different harnesses solve the
same task in genuinely different ways"). `maxClaimsPerOperator = 5` lets one
operator self-produce up to 5 near-copy trajectories of the same instance — the
exact copy surface DR-i caps.

### 2. Fill-the-pool posting, no cadence

The generator posts a Task for **every** scorable instance that is unposted and
unsaturated — as fast as a per-tick batch throttle (`post_batch_size`) allows —
so operators have a full supply of work immediately. There is no posting
cadence, interval, or `cadenceMs`. A trickle starves operators and contradicts
DR-i's own substrate-volume and bootstrap-surface rationale (the whole historical
pool *should* be live now, not metered out monthly).

`post_batch_size` is a chain-hammer throttle (post at most B Tasks per tick,
continuing batch-by-batch on subsequent ticks until the unposted set is live) —
not a cadence.

### 3. Retry-on-expiry is the only ongoing per-instance work

There is exactly **one live posting per instance** at a time. When a posting's
submission window expires without `successful_count ≥ N_target_successes`:

- if `posted_count ≥ N_max_postings_per_task` → **abandoned** (genuinely beyond
  current network capability), retire;
- otherwise → eligible for **repost**, with `maxClaims` re-sized to
  `N_target_successes − successful_count`.

A short `repost_drain_ms` grace after expiry, before the repost, lets verdicts
for solutions delivered near window-end land and be counted — so the repost is
sized against an up-to-date `successful_count`.

### 4. Lengthen the posting window

The task window moves from a hardcoded 7 days to a launcher-tunable
`posting_window_ms` (default ≈ 30 days). A posting must stay claimable long
enough to collect its N successes from a thin operator set before expiry forces a
needless repost (and inflates `posted_count` toward the `N_max` abandon cap on
otherwise-solvable tasks).

### 5. `cooldown_ms` is removed

With one-live-posting-per-instance and repost-only-after-expiry, the window
length *is* the repost spacing. The residual "do not repost the instant the
window closes" need is served by `repost_drain_ms`. The global cooldown gate
(`swe-rebench-v2.ts:381-389`) is deleted; `cooldown_ms` leaves the config and
manifest schema.

### 6. In-flight accounting — not tracked, tiny overshoot accepted

The expiry boundary serializes postings per instance, so no concurrent in-flight
attempts ever race a new posting. The only residual overshoot — a verdict landing
just after a window expires — is absorbed by `repost_drain_ms` and otherwise
accepted; `N_target_successes` is a soft target, not a hard wall. v1 keeps the
local `generator-state.json` success ledger (`posted`, `successful`,
`last_posted_at` is the complete state the generator needs). Migrating
success/in-flight counts to the subgraph — the canonical network-wide source DR-i
§Consequences named — is a scoped follow-up, required once multi-daemon
evaluation makes the local ledger under-count.

### Parameters after this DR

| Parameter | Before | After | Meaning |
|---|---|---|---|
| `N_target_successes` | 3 | 3 | memorisation cap — score=1 verdicts per instance before retire |
| `N_max_postings_per_task` | 10 | 10 | impossible-task cap |
| `cooldown_ms` | 24 h | **removed** | subsumed by `posting_window_ms` + `repost_drain_ms` |
| `posting_window_ms` | (7 d, hardcoded) | ≈ 30 d, launcher-tunable | how long a posted Task stays claimable |
| `repost_drain_ms` | — | ≈ 6 h | grace after expiry before repost; lets late verdicts count |
| `post_batch_size` | — | ≈ 25 | max Tasks posted per tick (chain-hammer throttle, not cadence) |
| `maxClaims` (per posting) | 50 (flat) | `N − successful_count` (derived) | the posting is the capacity unit |
| `maxClaimsPerOperator` | 5 | 1 | N trajectories from N distinct operators |

All of `N_target_successes`, `N_max_postings_per_task`, `posting_window_ms`,
`repost_drain_ms`, `post_batch_size` remain launcher-set in the manifest.

## Rationale

- **Generator-sized caps make the posting the unit of capacity.** The on-chain
  `TaskCoordinator` enforces the per-posting cap for free; no live claim-state
  query is needed; there is zero in-posting overshoot by construction. Total
  successes across reposts stay bounded because each repost re-sizes `maxClaims`
  down to the remaining budget.
- **Fill-the-pool matches DR-i's own reasoning.** DR-i argued the full ~750-task
  historical pool gives bootstrap surface and compounding corpus value. Posting
  it all *now* delivers that; a trickle delays it by a month and idles operators.
- **Retry-on-expiry serializes cleanly.** One live posting per instance means
  there is never an in-flight race, so the generator needs only local state — no
  indexer dependency for v1.
- **Accepting overshoot is cheap and correct here.** With the drain grace,
  overshoot is ≤ 1-2 per instance in the rare late-verdict case. An indexer query
  to eliminate it is not worth the dependency for a single-launcher testnet.
- **The longer window prevents false abandonment.** A 7-day window can expire
  before N successes accumulate on a thin operator set; that triggers needless
  reposts and can drive a solvable task to the `N_max` abandon cap.

## Alternatives considered and rejected

- **Small fixed `maxClaims` per posting (e.g. 3) + repost while successes < N.**
  Rejected: tolerates overshoot when all of a posting's claims succeed.
  Generator-sized caps achieve the same supply with zero in-posting overshoot.
- **On-chain instance-level claim cap via `policyHook`.** Rejected for v1: needs
  a new hook contract plus on-chain instance success state. Generator-sized
  `maxClaims` already gives a hard on-chain per-posting cap; the cross-repost
  total is bounded by re-sizing. Revisit only if a launcher cannot be trusted to
  size postings.
- **Keep `cooldown_ms` + a fixed posting cadence.** Rejected: this is the current
  design — it produced the under-posting failure mode and starves operators of
  work surface.
- **Source success/in-flight counts from the subgraph now.** Deferred, not
  rejected: correct per DR-i §Consequences, but unnecessary for a
  single-launcher testnet. Scoped as a follow-up for when multi-daemon
  evaluation is real.

## Consequences

- **DR-2026-05-06-i is amended.** Its posting-policy specifics — `cooldown_window`
  and the per-task posting loop — are superseded. The core P5 choice stands: full
  historical pool, `N_target_successes` as the memorisation cap,
  `N_max_postings_per_task` as the impossible-task cap.
- **Spec §3.6** of `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md`
  carries a proposed-amendment banner now and is rewritten to match this DR on
  ratification.
- **Implementation follow-up** (a `refactor`-shape issue): delete the global
  cooldown gate; `GeneratorConfig` drops `cooldown_ms`, adds `posting_window_ms`,
  `repost_drain_ms`, `post_batch_size`; `selectNextPostingCandidate` becomes a
  batch selector returning up to `post_batch_size` instances (`tick` already
  returns `Task | Task[] | null`); the generator sets per-posting `maxClaims =
  N − successful_count` and `maxClaimsPerOperator = 1`; the deadline derives from
  `posting_window_ms`; per-instance live/expired state derives from
  `last_posted_at + posting_window_ms`; the `swe-rebench-v2` contract
  `claimPolicyDefaults.maxClaimsPerOperator` changes `5 → 1`; the manifest schema
  gains the new params and drops `cooldown_ms`; regression tests cover both
  failure modes (one post must not stall the pool; one posting must not exceed N
  claims).
- **Thin-operator testnet note.** `maxClaimsPerOperator = 1` means an instance
  needs N distinct operators to saturate. While the testnet operator count is
  below `N_target_successes`, the launcher should lower `N_target_successes` (or,
  as a deliberate exception, raise `maxClaimsPerOperator`) in the manifest so the
  loop can close — a manifest tweak, no code change.
- **Spend.** Posting cost scales with `maxClaims` (`JinnRouterV3` escrows
  `solutionBudget = solutionMaxDeliveryRate × maxClaims`). Dropping `maxClaims`
  from 50 to ≤ N = 3 is ~16× cheaper per posting — which is what makes
  fill-the-pool affordable.

## Status

Proposed — drafted on `claude/issue-487-design` in a from-first-principles design
session with the issue author (ritsukai). Awaiting Captain ratification; on
ratification, spec §3.6 is rewritten and the implementation follow-up issue is
filed.
