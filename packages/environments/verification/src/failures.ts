// SPDX-License-Identifier: Apache-2.0

/** The protocol stages of design §5.3, in execution order. */
export const FAILURE_STAGES = ["acquire", "install", "run", "compare"] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

/**
 * The closed reason vocabulary the predicate's `failure.reason` draws from.
 * Free-form detail rides in `failure.detail`; the code is what consumers match.
 */
export const VERIFICATION_FAILURE_REASONS = [
  "image-unresolvable",
  "image-digest-mismatch",
  "install-command-failed",
  "run-command-failed",
  "runtime-timeout",
  "parser-produced-no-outcomes",
  "outcome-set-divergence",
] as const;
export type VerificationFailureReason = (typeof VERIFICATION_FAILURE_REASONS)[number];

/**
 * The four-way disposition the legacy harvest state machine used
 * (`client/src/solver-types/_swe-rebench-v2-harvest-state.ts`, reference only),
 * rewritten over this package's closed vocabulary. Design §6: `quarantined`
 * publishes an `unstable` attestation; `failed_infrastructure` retries, then
 * publishes an `error` attestation.
 */
export const FAILURE_DISPOSITIONS = [
  "terminal_policy",
  "awaiting_input",
  "quarantined",
  "failed_infrastructure",
] as const;
export type FailureDisposition = (typeof FAILURE_DISPOSITIONS)[number];

const DISPOSITION_BY_REASON: Readonly<
  Record<VerificationFailureReason, FailureDisposition>
> = Object.freeze({
  // Retryable: the registry, the network, or the host was having a bad day.
  "image-unresolvable": "failed_infrastructure",
  "install-command-failed": "failed_infrastructure",
  "run-command-failed": "failed_infrastructure",
  "runtime-timeout": "failed_infrastructure",
  // The record names a digest the registry resolves differently. Retrying the
  // same record can only reproduce it; the record itself must change.
  "image-digest-mismatch": "terminal_policy",
  // A record whose parser yields nothing needs a corrected record from whoever
  // declared it -- no amount of retrying supplies the missing input.
  "parser-produced-no-outcomes": "awaiting_input",
  // The environment ran and disagreed with itself: a published fact, not a bug.
  "outcome-set-divergence": "quarantined",
});

const STAGE_BY_REASON: Readonly<Record<VerificationFailureReason, FailureStage>> =
  Object.freeze({
    "image-unresolvable": "acquire",
    "image-digest-mismatch": "acquire",
    "install-command-failed": "install",
    "run-command-failed": "run",
    "runtime-timeout": "run",
    "parser-produced-no-outcomes": "run",
    "outcome-set-divergence": "compare",
  });

export function classifyVerificationFailure(
  reason: VerificationFailureReason,
): FailureDisposition {
  return DISPOSITION_BY_REASON[reason];
}

export function stageForFailureReason(reason: VerificationFailureReason): FailureStage {
  return STAGE_BY_REASON[reason];
}
