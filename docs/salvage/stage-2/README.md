# Stage-2 salvage — grader-container execution

**Date:** 2026-08-05
**Source:** PR #2350 (`cutover/stage-2-evaluator`), closed as superseded on this date.
**Status:** preserved source, not wired. These are `.txt` so nothing compiles or ships them.

## Why this directory exists

PR #2350 was closed because PR #2363 harvested its evaluator primitives into the native
estate ("adapted without cherry-picking", donor SHAs cited in #2363's commit bodies), and
because DR-2026-08-04-b ruled that native-v1's runtime is the machinery the cutover stages
swap in. Almost everything on #2350 is therefore superseded.

**One thing is not.** `packages/task-execution/evaluator-adapters/src/swe-rebench/adapter.ts`
defines `GraderReportSource` and states:

> This package ships only the hermetic context-backed implementation; a container-executing
> source is host or separately-chartered work (Finding A).

The host-side container-executing implementation exists **only** on #2350. Nothing on
`integration/evidence-v1` executes a grader container: `grader` appears in `client/src/`
solely in the legacy `eval/` and `harnesses/impls/jinn-repo-evaluator/` estate, which is a
different (pre-cutover) mechanism. Closing #2350 without preserving these files would have
deleted the only implementation of a component the shipped package boundary explicitly
delegates to the host.

## What is here

| File | Lines | Role |
| --- | --- | --- |
| `grader-execution.ts.txt` | 148 | Host `GraderReportSource`: provisions a workspace via `makeDirProvisioner` under capability grants, atomically writes `evaluation-context.json`, runs the container, reads `grader-output.json`. |
| `launcher.ts.txt` | 55 | `readEvaluationSpecFromInput` — the only intra-branch import `grader-execution.ts` has. |
| `grader-execution.test.ts.txt` | 43 | Its test, carried so the port has a starting assertion set. |

## What a port has to re-derive, not copy

These were written against #2350's evaluator shape, not the native one. A port must:

1. Re-target the `ContainerRuntime` seam at the native evaluator's deployment path
   (`client/src/daemon/native-evaluator-composition.ts` builds its launcher from
   `@jinn-network/task-execution-evaluation-harness`), rather than #2350's `launcher.ts`.
2. Decide whether `readEvaluationSpecFromInput` is still needed at all, or whether the
   harness's own spec resolution covers it — likely the latter, in which case
   `launcher.ts.txt` is reference only.
3. Re-derive capability grants against the native path, which seals evaluation Submissions
   with `capabilityGrants: {}` (see `client/src/evaluator/native-evaluation-derivation.ts`).
   #2350's grant model was the R1 evaluator-seals carve-out, which that empty-grants
   derivation dissolved — **do not carry the carve-out forward**.

Treat this as evidence of prior art and a test seed, not as a patch to apply.

## Related

- Composition program: `docs/superpowers/plans/2026-07-30-operator-daemon-composition-program.md`
- Stage-2 plan: `docs/superpowers/plans/2026-07-30-cutover-stage-2-evaluator-flow.md`
- Drain runbook (restored to its home in this same commit): `docs/runbooks/cutover-stage-2-drain.md`
- DR-2026-08-04-b: `log/decisions/2026-08-04-headless-operator-reconciliation.md`
