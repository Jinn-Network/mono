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

- `GraderReportSource` — resolves a swe-rebench grader report. Two implementations
  ship here. `contextGraderReportSource` reads an already-produced report from the
  runner design's §8.3 "supporting context" (`runtime.ts`'s `optionalContext`) and
  executes nothing. `containerGraderReportSource` *runs* the grader: it provisions an
  isolated 0700 workspace under a host-supplied root, atomically writes the subject
  material and an `evaluation-context.json` index, runs the specification's
  digest-pinned image through an injected `ContainerRuntime`, and reads back
  `grader-output.json`. It still shells out to nothing — the concrete Docker (or
  other) driver behind `ContainerRuntime` is host work (see Finding A).
- `ResolutionSnapshotSource` — resolves a prediction market's resolution snapshot.
  The in-package implementation, `contextResolutionSnapshotSource`, reads the
  snapshot from the same supporting-context channel. A live venue-reading
  `ResolutionSnapshotSource` is out of scope for this package (see Finding B).

## Findings carried from the design (see the plan for full detail)

- **Finding A** — nothing in the merged stack executed a `deterministic-process`
  grader (no container driver existed anywhere in the stack). This package defined the
  `GraderReportSource` port and originally shipped only the hermetic
  `contextGraderReportSource`. **Partially closed** by the one-swap cutover
  (DR-2026-08-05 decision 3a): `containerGraderReportSource` now performs the
  workspace, execution, and report-reading half in-package, against an injected
  `ContainerRuntime` port. The remaining half — the concrete container driver that
  actually spawns `docker run`, and the deployment module that injects it — is still
  host work, deliberately: a package that shells out is a package that cannot be
  tested hermetically.
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
  `totalCount` / `evaluator_cost_usd` cannot ride as measurements. The count fields
  ride in `detailedOutcome` as `failToPassExpected` / `failToPassSatisfied` /
  `passToPassExpected` / `passToPassBroken` / `containerExitCode`, from which the
  legacy `score` is derivable. `evaluator_cost_usd` rides **nowhere**: the legacy
  value is grader wall-clock elapsed time × a USD rate, and wall-clock time belongs
  to whichever `GraderReportSource` actually runs the grader. The hermetic
  context-backed source in this package runs nothing, so it has no honest elapsed
  time to report. Emitting a fabricated or zero cost would be worse than omitting it.
  A container-executing `GraderReportSource` (per Finding A) is the right place to
  reintroduce it — `containerGraderReportSource` now has the honest elapsed time, but
  it still has no channel to carry it: `RawGraderReport` is `{ report, log }`, and
  widening that shared shape is a separate change, not a side effect of adding a
  source. `evaluator_cost_usd` therefore still rides nowhere.

Per the coordinator amendments (2026-07-30), all four findings are ratified as
proposed and are not patched in this package or the harness runtime.

## What this package deliberately does not do

- **No container or Docker driver, and no live venue client.** Both are execution
  providers under the runner design's §5.4 ownership line. This package defines the
  injected ports — including `ContainerRuntime` — and every implementation it ships is
  hermetic: `containerGraderReportSource` composes a run request and reads a file, and
  never spawns a process.
- **No evaluator loop.** Observing deliveries, deriving the evaluation Submission,
  claiming the verdict attempt, and dispatching the Attempt are stage-2 work. This
  package is *called by* that loop's deployment module; it never runs one.
- **No new record or interchange format.** SARIF, JUnit XML, TAP, and benchmark-local
  JSON are ingestion formats parsed at the adapter edge. The only outward shape is
  `CompletedEvaluation`, which the harness composes into the signed Result Evaluation.
- **No changes to the harness runtime, the registration contract, the launcher, or
  `profiles`.** Findings there are surfaced with proposed dispositions, never patched.

## Unscorable is never a silent zero

An evaluation that could not grade the solution raises `EvaluationOperationalError`.
The harness runtime returns exit `EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE` (70),
the launcher maps that to `blame: "infrastructure"`, and **no verdict is written**. A
`fail` verdict is reserved for a solution that *was* graded and did not satisfy the
spec's `verdictRule`. `src/conformance.integration.test.ts` case 3 is the gate that
holds this property against the real `runEvaluationHarness`.

One consequence worth stating plainly: a malformed solver Result — unparseable JSON,
empty bytes, a probability outside `[0,1]` — is a graded `fail`, not an operational
error. The solver failed to deliver a valid result; the infrastructure did not fail to
grade one. The legacy prediction evaluator crashed on these inputs instead; this
package normalizes them to `fail` deliberately, and the prediction fixtures record it.

## Parser identity and the semantics documents

Each parser's `ParserIdentity.digest` is the SHA-256 of its own semantics document in
`fixtures/parsers/`, pinned by `src/parser-identity.test.ts`. Editing what a parser
promises without bumping its `version` therefore breaks the build rather than silently
changing what an allowlist key means. This rests on `parserAllowlistKey` incorporating
the digest — it does: `` `${id}@${version}#${digest}` `` — so a drifted digest is a
different key and the deployment allowlist refuses it. Conformance case 5 proves that
refusal end-to-end against the real runtime.

The semantics documents are shipped in the published tarball (`files` includes
`fixtures/`) because the digest is computed from their bytes at runtime.

## Legacy behavior enters as fixtures, never as ported code

Per the program's fresh-rewrite contract, no file from
`client/src/harnesses/impls/swe-rebench-v2-evaluator/` or
`client/src/harnesses/impls/prediction-v*-evaluator/` is ported, copied, or adapted as
code. Their behavior enters only as test fixtures and assertions, each citing the exact
legacy file and line range it was transcribed from. Those citations were verified
against the real legacy sources during execution, and a number of them were wrong — see
the "Execution findings" section (E1–E16) of
`docs/superpowers/plans/2026-07-30-evaluator-adapters.md` for the corrections, including
two fabricated enum members, a citation pointing at an unrelated function, and a fixture
whose data prevented it from exercising the code path it claimed to test.
