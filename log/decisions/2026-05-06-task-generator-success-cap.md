---
id: DR-2026-05-06-i
title: Task generation policy — full historical pool, post until target successes per task
date: 2026-05-06
verb: Steer
status: ratified
authors: ritsukai, opus (drafted on jinn-mono-9fe5)
spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md
---

## Context

DR-2026-05-06-b commits SWE-rebench v2 as the v1 benchmark — chosen because its monthly fresh-supply structure dissolves the cross-month memorisation vector that finite-pool benchmarks (apex-agents, GDPval, SWE-bench Pro) suffer. The active dataset (`nebius/SWE-rebench-leaderboard`) has 14 monthly partitions through 2026_02 with ~750 instances total at v1 launch, growing ~50 per month.

But fresh supply alone does not handle **within-task memorisation**. If the same task is posted N times on JinnRouter and operators read the corpus before claiming, the first successful trajectory becomes a near-template subsequent operators read and near-copy. The producer-consumer overlap mechanism — designed to compound learning — degrades into copying as N grows.

There is also a **substrate-volume question**. If the generator only posts the current month's drop (~50 tasks), the SolverNet has thin work surface between monthly partitions and new operators joining have to wait for the next drop to participate. Per the Captain's framing, this is wasteful: the historical pool is already curated, the corpus contains historical trajectories on similar tasks, and new operators arriving should have plenty of training surface immediately.

The launcher's Task generator design must address both: bound within-task memorisation explicitly, AND make full use of the historical pool for substrate volume. Several candidate policies were considered:

- **(P1) Post each task once only.** No memorisation vector but very low volume — only one operator gets to attempt each task; rest of the network is idle on this SolverNet.
- **(P2) Post each task many times until cycled out.** Highest volume but maximum memorisation surface; defeats the substrate property.
- **(P3) Post each task adaptively until target successes (current month only).** Track successful Solutions per task; stop reposting when target N is hit. Bounded memorisation but artificially low substrate volume — only ~50 tasks active at a time.
- **(P4) Round-only batched posting.** Post all 50 tasks at once each month, no replays. Subsumes P1 with batching.
- **(P5) Post adaptively until target successes, drawing from the full historical pool.** Same per-task cap as P3 but pool is the union of all monthly partitions minus saturated tasks. Higher substrate volume; bootstrap surface for new operators; corpus compounds across the full history.

## Decision

**Adopt (P5) — full historical pool, post until target successes per task.**

The launcher's Task generator runs against the union of all monthly partitions from `nebius/SWE-rebench-leaderboard` (currently `2025_01` through latest available, ~750 unique tasks), minus saturated tasks. Pool grows by ~50 per month as new partitions are added; saturated tasks are removed from the active pool but remain in the corpus as historical artifacts.

```ts
const fullPool = unionOfAllMonthlyPartitions(latestMonth); // ~750 tasks initially; grows monthly

for (const task of fullPool) {
  if (successful_count[task] >= N_target_successes) continue;       // saturated; remove from active pool
  if (taskInFlightOnChain(task))                    continue;       // wait for resolution
  if (posted_count[task] >= N_max_postings_per_task) continue;      // capped on impossible tasks
  if (now - last_posted_at[task] < cooldown_window)  continue;      // operator availability window

  await postTaskOnJinnRouter(task);
  posted_count[task] += 1;
  last_posted_at[task] = now;
}
```

**v1 defaults (launcher-tunable in the manifest):**

| Parameter | Default | Rationale |
|---|---|---|
| `N_target_successes` | 3 | Diversity of successful approaches without excessive memorisation surface. |
| `N_max_postings_per_task` | 10 | Cap on impossible tasks; avoid infinite replay. |
| `cooldown_window` | 24 hours | Operators need time to claim and attempt before reposting. |
| `pool_ordering` | round-robin balanced by language + month | Avoids starvation of older tasks; rotates languages so harnesses can specialise without one-language saturation blocking the rest. |

Saturated tasks remain in the corpus as historical artifacts; they are not re-posted even after months have passed. Their up-to-N successful trajectories serve as historical training data for future operators attempting *unsaturated* tasks — exactly the producer-consumer overlap mechanism doing its job at the per-task-class level rather than the same-task-instance level.

## Rationale

- **Full historical pool unlocks substrate volume.** ~750 unsaturated tasks at v1 launch × N=3 target successes = up to ~2,250 successful Solutions during the initial saturation phase, plus failed attempts (~5-10× successful counts on hard tasks). This is materially more substrate volume than current-month-only would give (~150 successful Solutions per month under that framing).
- **Bootstrap surface for new operators.** New operators joining the network shouldn't have to wait for next month's drop to find work. The full historical pool gives them immediate task surface; their attempts contribute to substrate flow even before they've seen a fresh monthly drop.
- **Per-task N=3 cap preserved.** The within-task memorisation surface is bounded by N regardless of pool size. Posting from the full pool doesn't widen the per-task copying surface; it just gives the generator a much larger queue of unsaturated tasks to draw from.
- **Captures the diversity sweet spot at N=3.** The first successful Solution is rarely the only good approach — different Harnesses solve the same task in different ways (different test-discovery strategies, different patch-generation approaches, different multi-file edit orderings). Multiple successful trajectories in the corpus is itself substrate value. Stopping at N=1 throws this away.
- **Bounds the copying surface at N=3.** After 3 successful trajectories appear in the corpus for a task, marginal copyability outweighs marginal diversity. Operators 4+ attempting the same task would predominantly read-and-copy. The cap preserves substrate value while capping the surface.
- **Corpus compounds across the full monthly history.** A 2026-02 task being attempted today benefits from peer trajectories on similar 2025-08 tasks already in the corpus. The producer-consumer overlap operates across the full monthly partition history. Limiting the pool to one month would artificially throw away that compounding surface.
- **Failed attempts are still substrate signal.** Operators learn from failures too. The policy is "stop posting after N successes," not "stop posting after N attempts" — failed attempts continue until either a success or max-postings cap.
- **Launcher-tunable.** Different launchers can pick different N values for their own launched instance. Free market for posting-policy parameters.

## Alternatives considered and rejected

- **(P1) Post each task once only.** Rejected: very low substrate volume; operators idle. Defeats the substrate property in a different direction.
- **(P2) Post each task many times.** Rejected: maximum memorisation surface; defeats fresh-supply property of DR-b.
- **(P3) Adaptive but current-month-only.** Rejected: artificially low substrate volume (~50 active tasks at a time); ignores the value of historical partitions; new operators have nothing to attempt between monthly drops. The earlier draft of this DR selected P3 before the Captain's clarification surfaced the historical-pool framing.
- **(P4) Round-only batched posting.** Rejected: doesn't address the case where most operators don't claim a particular task during its window; that task gets one attempt or none. P5 ensures every task gets meaningful coverage while still bounded.
- **Stop at N=1 (first success).** Rejected: kills diversity of successful approaches in the corpus.
- **Higher N targets (N=5, N=10).** Rejected for v1: increases memorisation surface materially; the diversity benefit per additional success is diminishing. Could be revisited at v2 if empirically warranted.
- **Drop saturated tasks from the corpus when they retire from the active pool.** Rejected: saturated tasks' successful trajectories remain valuable substrate signal for future operators learning task-class techniques. Retirement from the *posting* surface is not retirement from the *corpus*.

## Consequences

- **`swe-rebench-v2` substrate volume is meaningfully higher than current-month-only would give.** Initial saturation phase: ~2,250 successful Solutions + failed attempts. Equilibrium (post initial saturation): ~150 successful Solutions/month from the new monthly drop + residual unsaturated tasks (impossible-task tail). Operators run `prediction.v1` in parallel for additional Polymarket-fresh substrate flow.
- **Generator complexity grows modestly.** The launcher's generator tracks per-task success counters, in-flight state, cooldown timers across the full historical pool. Engineering scope: ~2-3 days on top of the basic generator plumbing. Memory footprint scales linearly with pool size — at ~750 tasks × small per-task state, trivial.
- **Subgraph indexes per-task posting and success counts.** Already part of the SolverNet rollups; no new indexing required, just exposed as queryable per-task state for the generator's own consumption.
- **Pool ordering matters.** Naive iteration would post oldest tasks first, starving newest tasks of attention. The default `pool_ordering: round-robin balanced by language + month` prevents this; ensures fresh tasks get attention without starving the historical pool. Launcher-tunable.
- **Multi-launcher coordination is future work.** If multiple launchers launch independent `swe-rebench-v2` instances, each runs its own generator policy independently; aggregate memorisation surface = N × num_launched_instances. For v1 we expect one canonical launched instance. Cross-launcher coordination (shared registry of saturated tasks; VRF-based task assignment between launchers; cooperative posting policy) is filed as v1.5+ work when multiple launchers are demonstrably in flight.
- **Manifest schema includes the policy parameters.** Launchers declare `N_target_successes`, `N_max_postings_per_task`, `cooldown_window`, `pool_ordering` in the launched-instance manifest per the existing parameter pattern in `2026-05-05-solvernet-creation-and-launch.md` v0.2 §6.2.

## Status

Ratified by Captain ritsukai during the design exercise on jinn-mono-9fe5; locked 2026-05-06. Earlier same-day draft selected (P3) current-month-only; pivoted to (P5) full-historical-pool after Captain clarification on substrate volume + bootstrap-surface reasoning.
