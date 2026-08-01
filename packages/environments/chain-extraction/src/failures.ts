// SPDX-License-Identifier: Apache-2.0

/** The pipeline stages of design §7, in execution order. */
export const EXTRACTION_STAGES = [
  "anchor",
  "baseline",
  "harvest",
  "assemble",
  "reverify",
] as const;
export type ExtractionStage = (typeof EXTRACTION_STAGES)[number];

/**
 * The closed reason vocabulary. Free-form detail rides in `detail`; the code is what a
 * caller matches on and what the staged state file stores.
 */
export const EXTRACTION_FAILURE_REASONS = [
  // The archive could not supply the anchored world at all.
  "archive-unreachable",
  "archive-anchor-pruned",
  "archive-proof-unsupported",
  // The archive contradicted itself or the anchor it was asked about.
  "archive-self-disagreement",
  "archive-root-mismatch",
  // The world would not close.
  "baseline-unstable",
  "divergence-unexplained",
  "widen-bound-exhausted",
  // A rule this package refuses to break, whatever the caller wants.
  "archive-budget-exhausted",
  "coverage-incomplete",
  "harvest-empty",
  "widen-bound-above-ceiling",
  // CE3 refused the record for a reason widening cannot address (runtime identity,
  // capability, proof validity). The record must change, not the slice.
  "verification-refused",
  // The host's own machinery failed.
  "runtime-failure",
  "artifact-store-failure",
] as const;
export type ExtractionFailureReason = (typeof EXTRACTION_FAILURE_REASONS)[number];

/**
 * Five dispositions, each answering a different operator question:
 * `archive-unavailable` -- get different archive access; `provider-disagreement` -- the
 * archive is lying or racing, do not trust this extraction; `non-convergent` -- the world
 * cannot be closed as specified; `policy` -- a declared bound or rule stopped this,
 * raising it is a decision, not a retry; `infrastructure` -- the host broke, retry is
 * meaningful.
 */
export const EXTRACTION_FAILURE_DISPOSITIONS = [
  "archive-unavailable",
  "provider-disagreement",
  "non-convergent",
  "policy",
  "infrastructure",
] as const;
export type ExtractionFailureDisposition =
  (typeof EXTRACTION_FAILURE_DISPOSITIONS)[number];

const DISPOSITION_BY_REASON: Readonly<
  Record<ExtractionFailureReason, ExtractionFailureDisposition>
> = Object.freeze({
  "archive-unreachable": "archive-unavailable",
  "archive-anchor-pruned": "archive-unavailable",
  "archive-proof-unsupported": "archive-unavailable",
  "archive-self-disagreement": "provider-disagreement",
  "archive-root-mismatch": "provider-disagreement",
  "baseline-unstable": "non-convergent",
  "divergence-unexplained": "non-convergent",
  "widen-bound-exhausted": "non-convergent",
  "archive-budget-exhausted": "policy",
  "coverage-incomplete": "policy",
  "harvest-empty": "policy",
  "widen-bound-above-ceiling": "policy",
  "verification-refused": "policy",
  "runtime-failure": "infrastructure",
  "artifact-store-failure": "infrastructure",
});

const STAGE_BY_REASON: Readonly<Record<ExtractionFailureReason, ExtractionStage>> =
  Object.freeze({
    "archive-unreachable": "anchor",
    "archive-anchor-pruned": "anchor",
    "archive-proof-unsupported": "assemble",
    "archive-self-disagreement": "anchor",
    "archive-root-mismatch": "assemble",
    "baseline-unstable": "baseline",
    "divergence-unexplained": "reverify",
    "widen-bound-exhausted": "reverify",
    "archive-budget-exhausted": "reverify",
    "coverage-incomplete": "assemble",
    "harvest-empty": "harvest",
    "widen-bound-above-ceiling": "anchor",
    "verification-refused": "reverify",
    "runtime-failure": "baseline",
    "artifact-store-failure": "assemble",
  });

export function classifyExtractionFailure(
  reason: ExtractionFailureReason,
): ExtractionFailureDisposition {
  return DISPOSITION_BY_REASON[reason];
}

export function stageForExtractionFailure(
  reason: ExtractionFailureReason,
): ExtractionStage {
  return STAGE_BY_REASON[reason];
}

/**
 * Only `infrastructure` is worth another attempt with the same inputs. Every other
 * disposition needs a human decision: different archive access, a different anchor, a
 * wider bound, or a different world.
 */
export function isRetryableExtractionFailure(reason: ExtractionFailureReason): boolean {
  return classifyExtractionFailure(reason) === "infrastructure";
}
