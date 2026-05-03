# Prediction SolverNet Brier Dashboard Plan

## Status

Ratified implementation handoff for `jinn-mono-xp33` and `jinn-mono-l2zl.5`.

The Prediction SolverNet v1 scoreboard should be built on the generic corpus/indexed envelope projection path that landed with the task-native lifecycle work. It must not introduce a Prediction-specific canonical database.

## Source Of Truth

The source of truth is the generic envelope corpus plus its materialized projection index:

- `prediction.v1` forecast Solution envelopes.
- `prediction.v1` evaluator Verdict envelopes.
- Task identity from `taskCid` and `taskId`.
- Solver operator identity from Solution-envelope `participant.safeAddress` and `participant.agentEoa`.
- Solver Harness/runtime attribution from Solution-envelope `executor.implName`, `executor.implVersion`, and `executor.runtimeBundleDigest`.
- Solver plugin attribution from Solution-envelope `executor.plugins`.

A hosted dashboard or generated report may denormalize these fields for convenience, but those denormalized rows are derived artifacts. They are not protocol state.

## Scoreable Row Definition

The initial scoreboard should consume `queryScoreablePredictionBrierVerdicts()` from `client/src/corpus/prediction-scoreable-verdicts.ts`.

A Verdict is scoreable only when all of the following are true:

- `solverType` is `prediction.v1`.
- `role` is `verdict`.
- `metadata.verdict` is `SCORED`.
- `scores.solverBrier`, `scores.consensusBrier`, and `scores.brierSpread` are present.

`REJECTED`, `INVALID`, unresolved, indeterminate, and malformed Verdicts are excluded from Brier aggregates. They should still be counted separately once the report grows invalid/rejected rate sections.

## Public Grouping Model

Public metrics group submissions under the shared Task:

- Primary Task key: `taskCid`, with `taskId` as the human/stable display key when present.
- Submission key: `solutionEnvelopeCid`, `solutionEnvelopeSha256`, or `solutionEnvelopeRef`.
- Verdict key: the Verdict projection `envelopeCid`, `envelopeSha256`, or `envelopeId`.
- Operator key: Solution projection `participantSafeAddress`, then `participantAgentEoa` if Safe is absent.
- Harness key: Solution projection `executorImplName` plus `executorImplVersion`.
- Plugin key: entries in Solution projection `executorPlugins`.

`requestId` and `attemptIndex` are trace/debug fields only. The dashboard must not treat each attempt request as a separate public Task.

Score rows come from Verdict projections, but public Solver attribution should join back to the scored Solution projection using the Verdict `solutionEnvelope` reference. If only Verdict projections are available, report code may fall back to Verdict attribution, but that is an incomplete local/debug view rather than the public operator ranking.

## Metrics

The headline metric is trailing 84-day mean `brierSpread` across scoreable Verdicts:

```text
solverBrier = (solution.probabilityYes - outcome)^2
consensusBrier = (task.consensusSnapshot.probabilityYes - outcome)^2
brierSpread = solverBrier - consensusBrier
```

Smaller is better. Negative `brierSpread` means the Solver beat the Polymarket consensus snapshot for that scored forecast round.

Initial supporting metrics:

- Mean solver Brier.
- Mean consensus Brier.
- Scoreable Verdict count.
- Distinct shared Task count.
- Distinct active operator count.
- Per-operator mean Brier spread and count.
- Per-Harness mean Brier spread and count.
- Per-plugin mean Brier spread and count.
- Weekly trend buckets by Verdict `generatedAt`.

The 84-day window should use Verdict projection `generatedAt`, because scoring happens when the evaluator emits the Verdict. Future reports may add market-resolution-time windows, but that is not required for the first scoreboard.

## First Artifact

The first deliverable should be a repo-rendered Markdown scoreboard, not a hosted UI:

- Output: `docs/superpowers/reports/prediction-solvernet-scoreboard.md`.
- Input: the local store's envelope projection index or an injected projection list in tests.
- Mode: deterministic report generation with an explicit "insufficient data" state when no scoreable Verdicts exist.

This keeps the next phase implementation small and validates the data model before investing in the public web surface at `https://jinn.network/solvernets/prediction`.

## Implementation Slices

### Slice 1: Aggregation

Add a typed aggregation module that accepts scoreable `EnvelopeProjection` rows and returns:

- Overall trailing 84-day summary.
- Weekly trend buckets.
- Per-operator, per-Harness, and per-plugin summaries.
- Excluded/non-scoreable counters when raw projection input is supplied.

The module should parse Brier metadata defensively and keep invalid numeric values out of score aggregates.

### Slice 2: Report Rendering

Add a report renderer/CLI path that writes the Markdown artifact. The report should show:

- Headline trailing 84-day mean Brier spread.
- Solver and consensus Brier means.
- Counts for scored Verdicts, Tasks, and operators.
- Weekly trend.
- Operator, Harness, and plugin tables.
- Insufficient-data and stale-data states.

### Slice 3: Validation

Add focused tests using seeded in-memory projections:

- Scored Verdicts with complete Brier metadata are included.
- Rejected, invalid, unresolved, and incomplete Verdicts are excluded from Brier aggregates.
- Rows group by shared `taskCid`/`taskId`, not by `requestId`.
- The 84-day window uses Verdict `generatedAt`.
- Operator, Harness, and plugin attribution are preserved.
- The rendered report is deterministic.

## Out Of Scope

- A hosted dashboard UI.
- Prediction-specific canonical database tables.
- Mainnet campaign launch.
- On-chain aggregate scoring.
- Multi-evaluator consensus.
- Component-level contribution attribution below plugin granularity.
- veJINN demand or economic incentive modeling.

## Validation Commands

Expected focused validation after implementation:

```bash
cd client
yarn test test/corpus/prediction-scoreable-verdicts.test.ts
yarn test test/corpus/prediction-brier-scoreboard.test.ts
yarn test test/corpus/prediction-brier-scoreboard-report.test.ts
yarn test test/cli/commands/prediction-scoreboard.test.ts
yarn tsc --noEmit
```

Repo report refresh command:

```bash
cd client
yarn jinn prediction-scoreboard --output ../docs/superpowers/reports/prediction-solvernet-scoreboard.md
```
