# SWE-rebench v2 eval admission — fail-closed + verdict-time recheck + SkippableError residual

Date: 2026-05-14
Author: opus
Output of: `jinn-mono-fufn` (spike); closes `jinn-mono-b609` (in favour of this approach)

## Summary

Adopt admission-fail-closed for the SWE-rebench v2 launched/public generator,
plus verdict-time substrate recheck, plus `SkippableError` for residual drift.
Do not emit `Invalid(3)` for ungradeable evals in this phase.

## Context

The 2026-05-14 triage surfaced ~64% of recent FAIL verdicts as eval-container
failures, not model failures. The spike (see `docs/superpowers/specs/2026-05-14-eval-substrate-spike.md`)
explored where the eval boundary belongs, verdict polarity, cross-SolverType
generalisation, and upstream-forking trade-offs; this DR ratifies the v1
implementation choice.

## Decision

- Public/launched generators default to `admissionMode: 'required'`. No
  posting unless the instance is admitted (`scorable: true`) under the current
  `EVAL_SEMANTICS_VERSION`.
- Admission record extended with `rowHash`, `imageName`, `imageDigest`,
  `upstreamEvalCommit`.
- Evaluator rechecks the admission record + recomputes `rowHash` + compares
  `imageDigest` at verdict time. Any mismatch → `SkippableError` (no
  on-chain verdict). HF fetch failures at verdict time → `SkippableError`
  after retry budget exhausted.
- Local/dev preserves today's behaviour via explicit
  `admissionMode: 'python-floor'`.
- Ungradeable evals continue to throw `SkippableError` (no on-chain verdict),
  not `Invalid(3)`. Activity-counter contribution for ungradeables is
  deferred.

## Explicitly NOT done

- `Invalid(3)` emission for ungradeable evals (`jinn-mono-b609` closed).
- Typed `EvalSubstrate` primitive on `SolverNetContract`.
- TEE attestation of the eval substrate.
- Protocol-enforced admission attestation in ValidationRegistry.
- Backfill reclassification of the 107 historical verdicts.
- Explorer per-verdict `failureMode` column (`jinn-mono-tptp` remains open).

## Revisit triggers

- Residual `SkippableError` rate exceeds 5% of attempted evals over a 30-day
  window. Mechanism: emit `Invalid(3)` with `failureMode` instead of
  silent skip.
- A second SolverType requires the same admission pattern. Mechanism:
  extract shared admission/substrate shape from the swe-rebench-v2
  implementation.

## Rationale

- Admission gating addresses the cause (broken instances should never
  become Tasks) instead of the symptom (post-hoc reclassification).
- `SkippableError` residual keeps the on-chain signal honest about what
  the chain knows: nothing, because the eval didn't grade. Emitting
  `Invalid(3)` would require recalibrating the OLAS activity-checker
  reward formula; skipping leaves that work for later.
- `rowHash` + `imageDigest` recheck at verdict time catches drift between
  admission and grading — the case neither pure admission gating nor pure
  classifier-fix would catch on its own.
- The spike's §4 also recommended a polarity flip (allowlist with `Invalid`
  default at the harness, `b609` upgraded to P1). We close `b609` rather than
  promote it because admission-fail-closed makes the polarity flip redundant
  for the launched generator: broken instances never become Tasks, so the
  harness never observes them. The remaining failure mode — substrate drift
  between admission time and verdict time — is caught by the verdict-time
  recheck (rowHash + imageDigest) and surfaces as `SkippableError`. Local/dev
  operators running `admissionMode: 'python-floor'` accept the absence of an
  admission filter; for them the existing harness denylist (extended in this
  release with the four 2026-05-14 fingerprints) continues to classify obvious
  infra failures. If residual `SkippableError` rates climb past the trigger
  above, the polarity flip becomes the next move.

## References

- Spike output: `docs/superpowers/specs/2026-05-14-eval-substrate-spike.md`
- Implementation plan: `docs/superpowers/plans/2026-05-14-eval-substrate-admission.md`
- bd: `jinn-mono-fufn`, closed `jinn-mono-b609`, closed `jinn-mono-xw6i`,
  closed `jinn-mono-y4ah`, open `jinn-mono-tptp`, open `jinn-mono-nf92`
