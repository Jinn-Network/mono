# `@jinn-network/task-execution-evaluator-adapters`

Concrete evaluator adapters for the Jinn evaluation harness
(`@jinn-network/task-execution-evaluation-harness`). This package ships two
`EvaluatorAdapter` implementations plus the deployment-allowlist entries that let
`runEvaluationHarness` resolve them:

- **swe-rebench** — parses the upstream SWE-rebench-V2 grader report into a
  `CompletedEvaluation`, classifying container/tooling failures as unscorable rather
  than as a failing verdict.
- **prediction** — scores a solver's probability submission against a prediction
  market's resolution outcome (Brier loss), modeled as a `deterministic-process`
  evaluation whose resolution data arrives as supporting context.

Each adapter is a thin composition of one **pure ingestion parser** (raw grader
report or raw solver Result → a normalized outcome, or a typed ungradeable
classification) with one **injected execution provider** (evaluation-runner design
§5.4/§11). No adapter reinterprets scores, invents thresholds, or emits a record
format: the verdict leaves as a `CompletedEvaluation` in Jinn's sealed-record
grammar, which the harness runtime turns into the signed Result Evaluation.

## Injected provider ports

- `GraderReportSource` — resolves an already-produced swe-rebench grader report from
  the harness-supplied evaluation context. The in-package implementation,
  `contextGraderReportSource`, reads the report from the runner design's §8.3
  "supporting context" (`runtime.ts`'s `optionalContext`). A container-executing
  `GraderReportSource` is out of scope for this package (see Finding A).
- `ResolutionSnapshotSource` — resolves a prediction market's resolution snapshot.
  The in-package implementation, `contextResolutionSnapshotSource`, reads the
  snapshot from the same supporting-context channel. A live venue-reading
  `ResolutionSnapshotSource` is out of scope for this package (see Finding B).

## Findings carried from the design (see the plan for full detail)

- **Finding A** — nothing in the merged stack executes a `deterministic-process`
  grader (no container driver exists anywhere in the current stack). This package
  defines the `GraderReportSource` port and ships only the hermetic
  `contextGraderReportSource`; a container-executing implementation is stage-2 host
  work or a separately chartered tree.
- **Finding B** — the prediction evaluator's ground truth is a live venue read, and
  none of the four frozen `EvaluationSpec` grader families natively describes
  "deterministic scorer over an external observation". This package models
  prediction evaluation as `deterministic-process` whose `parser` identity is the
  scorer's semantic commitment, with the resolution snapshot arriving as supporting
  context.
- **Finding C** — the harness runtime never forwards a declared unscorable class to
  the verdict-consistency check, so an adapter can only deliver `inconclusive` when
  the spec's `verdictRule` recomputes to `inconclusive` under a declared
  `inconclusiveWhen` predicate. The prediction fixture spec carries an explicit
  `inconclusiveWhen`; swe-rebench never returns `inconclusive`.
- **Finding D** — the canonical swe-rebench `EvaluationSpec` declares exactly one
  measurement (`passed`), so the legacy verdict payload's `score` / `passedCount` /
  `totalCount` / `evaluator_cost_usd` cannot ride as measurements. They ride in
  `detailedOutcome` instead.

Per the coordinator amendments (2026-07-30), all four findings are ratified as
proposed and are not patched in this package or the harness runtime.
