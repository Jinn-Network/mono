---
id: DR-2026-05-06-e
title: Aggregation function — structured multi-winrate result
date: 2026-05-06
verb: Steer
status: ratified
authors: ritsukai, opus (drafted on jinn-mono-9fe5)
spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md
---

## Context

A SolverNet contract per `2026-05-05-solvernet-creation-and-launch.md` v0.2 §3 carries an `aggregationFunction` with `id` + windowing parameters. For `prediction.v1` it is something like rolling Brier-spread vs Polymarket consensus over a 30-day window — one scalar.

For a benchmark SolverNet, what should the aggregation produce? Several candidates were evaluated:
- (A) Single mean win-rate scalar.
- (B) Single dollar-weighted win-rate scalar (economic alignment with task value).
- (C) Sector-balanced single scalar (fair across stratified Task population).
- (D) Frontier-of-network scalar (mean of top-K Solutions per Task).
- (E) Structured result returning multiple metrics.

## Decision

**Adopt (E) — structured result returning multiple metrics.** The aggregation function for `swe-rebench-v2` v1 returns:

```ts
interface SWERebenchV2NetworkResult {
  schemaVersion: 'swe-rebench-v2.network.v1';
  windowStart: string; windowEnd: string;
  verdictCount: number; uniqueOperators: number; uniqueCheckpoints: number;

  // Headline win-rates — all reported, all sortable
  meanResolved:           number;  // raw mean Verdict.score (= OpenAI-style "% Pass@1")
  complexityWeighted:     number;  // weighted by task-complexity proxy (LoC × file count)
  byLanguage:             Record<string, { resolved: number; n: number }>;
  frontierResolved:       number;  // mean of top-K Solutions per Task (best-of-network)
  parityTripRate:         number;  // % Tasks where best-of-network resolved
}
```

Window: rolling 30-day. Recomputed per-Verdict-settlement or per-batch.

## Rationale

- **Single-scalar reductions throw away information.** A 30-point JS/TS gap vs Python is a real signal; a sector-balanced scalar hides it. Operators specialising on JS/TS are a useful market subset; the leaderboard surface should reveal them.
- **Multiple metrics serve multiple audiences.** External comms wants `meanResolved` (OpenAI-comparable). The reward function (DR-f) operates on `complexityWeighted` (economic alignment). Recruitment narrates frontier and parity-trip rates ("the network is closing the gap on the hardest tasks"). Per-language breakdowns serve operators considering specialisation.
- **Deterministic, reproducible.** All metrics are pure functions of the Verdict stream; anyone can re-derive from subgraph state. Challenge arbitration straightforward.
- **Aggregation is launcher-side / dashboard-side.** The SolverNet contract pins the `id` and windowing; the actual computation happens off-chain (subgraph + dashboard). On-chain reward distribution operates on individual `Verdict.score` values per Task, not on the aggregation result (DR-f).

## Alternatives considered and rejected

- **(A) Single mean win-rate.** Simpler but information-poor. Rejected.
- **(B) Single dollar-weighted scalar.** Economic alignment is right (selected for the reward function in DR-f) but reducing the headline to a single number loses the diagnostic surface (per-language, frontier, parity).
- **(C) Sector-balanced single scalar.** Fair across stratified populations; loses the per-stratum signal that operators care about. Selected only for sub-aggregation within `byLanguage`.
- **(D) Frontier-only.** Reports "best-of-network" which is recruitment-attractive but ignores network breadth. Selected as one metric among several, not as the headline.

## Consequences

- **Subgraph computes the structured result on each Verdict settlement.** Engineering scope: ~1 day on top of basic Verdict indexing.
- **Dashboard surfaces multiple panels.** Headline `meanResolved` for casual readers; `complexityWeighted` for the economic narrative; `byLanguage` for stratified diagnostic; `frontierResolved` for recruitment; `parityTripRate` for capability-front trend over time.
- **The reward function operates on per-Task `Verdict.score` directly.** The aggregation's `complexityWeighted` is a derived metric, not the on-chain reward computation. Reward distribution is pinned in DR-f.
- **External comms can pick the metric most fitting the audience.** "Network mean Pass@1: 0.41" for OpenAI-comparable framing; "complexity-weighted resolved rate: 0.38" for economic-substrate framing; "frontier resolved: 0.59" for recruitment-attractive framing. All defensible because all derive from the same Verdict stream.

## Status

Ratified by Captain ritsukai during the design exercise on jinn-mono-9fe5; locked 2026-05-06.
