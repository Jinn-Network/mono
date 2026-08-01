// SPDX-License-Identifier: Apache-2.0

/**
 * Design §5.3's closed outcome partition, in the order the design lists it. Adding a member
 * is a design amendment, not a local choice: consumers match on these identifiers.
 */
export const CHAIN_VERIFICATION_OUTCOMES = [
  "closed-reproducible",
  "archive-observed",
  "artifact-unavailable",
  "runtime-identity-mismatch",
  "source-anchor-mismatch",
  "source-proof-invalid",
  "initial-state-mismatch",
  "offline-dependency-detected",
  "capability-mismatch",
  "probe-divergence",
  "reset-divergence",
  "provider-disagreement",
  "source-coverage-incomplete",
  "verification-infrastructure-failure",
] as const;
export type ChainVerificationOutcome = (typeof CHAIN_VERIFICATION_OUTCOMES)[number];

/**
 * The outcomes for which a complete K-run observation exists. Design §5.3's presence rule is
 * "repetition/observation blocks present iff runs occurred"; this is that rule as a closed
 * set, so the predicate schema can enforce it mechanically rather than by prose (Finding
 * F-CE3-3). Everything else carries partial observations as `evidence`, never as `runs`: a
 * truncated run sequence is not a repetition claim.
 */
export const RUN_BEARING_OUTCOMES = [
  "closed-reproducible",
  "archive-observed",
  "probe-divergence",
  "reset-divergence",
  "provider-disagreement",
] as const;
export type RunBearingOutcome = (typeof RUN_BEARING_OUTCOMES)[number];

export function isRunBearingOutcome(
  outcome: ChainVerificationOutcome,
): outcome is RunBearingOutcome {
  return (RUN_BEARING_OUTCOMES as readonly string[]).includes(outcome);
}

/** The protocol stages of design §5.1, in execution order; steps 8-9 collapse into `compare`. */
export const CHAIN_VERIFICATION_STAGES = [
  "resolve",      // step 1
  "isolate",      // step 2
  "identify",     // step 3
  "provenance",   // step 4
  "instantiate",  // step 5
  "probe",        // step 6
  "execute",      // step 7
  "compare",      // steps 8-9
] as const;
export type ChainVerificationStage = (typeof CHAIN_VERIFICATION_STAGES)[number];

/** The closed reason vocabulary the predicate's `failure.reason` draws from. Free-form
 * detail rides in `failure.detail`; the code is what consumers match. */
export const CHAIN_VERIFICATION_FAILURE_REASONS = [
  // resolve
  "resource-unresolvable",
  "resource-digest-mismatch",
  // isolate + compare-time closure
  "egress-succeeded",
  "fork-backend-fetch-unrefused",
  "uncommitted-resource-loaded",
  "out-of-slice-read-not-empty",
  // identify (step 3 covers determinism controls, per design §5.1)
  "runtime-image-mismatch",
  "runtime-version-mismatch",
  "runtime-chain-id-mismatch",
  "determinism-control-unsupported",
  // provenance
  "anchor-block-mismatch",
  "anchor-root-mismatch",
  "state-proof-invalid",
  "code-hash-mismatch",
  "artifact-entry-uncovered",
  "undeclared-source-mutation",
  // instantiate
  "post-fixture-commitment-mismatch",
  "fixture-transcript-mismatch",
  // probe (capability, isolation, composition)
  "rpc-allowlist-violation",
  "signer-scope-violation",
  "ceiling-not-enforced",
  "fixture-probe-failed",
  "origin-routing-collision",
  "request-key-divergence",
  "miss-policy-violation",
  "request-budget-not-enforced",
  // compare
  "probe-observation-divergence",
  "reset-observation-divergence",
  "provider-observation-disagreement",
  // infrastructure
  "materializer-failed",
  // CE1's `ChainInstance.report` is optional so a solver's local runner is not forced to
  // synthesise evidence it has no use for. A materializer used for verification must produce
  // one; its absence is checked, never asserted away (CE1 correction 3).
  "materialization-report-absent",
  "probe-executor-failed",
  "run-timeout",
  "information-runtime-absent",
] as const;
export type ChainVerificationFailureReason =
  (typeof CHAIN_VERIFICATION_FAILURE_REASONS)[number];

const OUTCOME_BY_REASON: Readonly<
  Record<ChainVerificationFailureReason, ChainVerificationOutcome>
> = Object.freeze({
  "resource-unresolvable": "artifact-unavailable",
  "resource-digest-mismatch": "artifact-unavailable",

  "egress-succeeded": "offline-dependency-detected",
  "fork-backend-fetch-unrefused": "offline-dependency-detected",
  "uncommitted-resource-loaded": "offline-dependency-detected",
  // §4.2's boundary rule: outside the slice reads EMPTY. A non-empty answer means something
  // supplied state the artifact does not carry.
  "out-of-slice-read-not-empty": "offline-dependency-detected",

  "runtime-image-mismatch": "runtime-identity-mismatch",
  "runtime-version-mismatch": "runtime-identity-mismatch",
  "runtime-chain-id-mismatch": "runtime-identity-mismatch",
  // §5.1 step 3 verifies determinism controls as part of runtime identity, and §10 warns that
  // a pinned Anvil may not support every control a record declares. Declaring a control the
  // runtime cannot apply is exactly the over-claim contract 7 exists to stop.
  "determinism-control-unsupported": "runtime-identity-mismatch",

  "anchor-block-mismatch": "source-anchor-mismatch",
  "anchor-root-mismatch": "source-anchor-mismatch",
  "state-proof-invalid": "source-proof-invalid",
  "code-hash-mismatch": "source-proof-invalid",
  "artifact-entry-uncovered": "source-coverage-incomplete",
  "undeclared-source-mutation": "source-coverage-incomplete",

  "post-fixture-commitment-mismatch": "initial-state-mismatch",
  "fixture-transcript-mismatch": "initial-state-mismatch",

  "rpc-allowlist-violation": "capability-mismatch",
  "signer-scope-violation": "capability-mismatch",
  "ceiling-not-enforced": "capability-mismatch",
  "fixture-probe-failed": "capability-mismatch",
  // Composition properties are part of the declared capability surface of the composite
  // (Finding F-CE3-5): the outcome vocabulary is closed and `capability-mismatch` is the
  // honest member for a world whose declared routing, budget, or miss policy does not hold.
  "origin-routing-collision": "capability-mismatch",
  "request-key-divergence": "capability-mismatch",
  "miss-policy-violation": "capability-mismatch",
  "request-budget-not-enforced": "capability-mismatch",

  "probe-observation-divergence": "probe-divergence",
  "reset-observation-divergence": "reset-divergence",
  "provider-observation-disagreement": "provider-disagreement",

  "materializer-failed": "verification-infrastructure-failure",
  "materialization-report-absent": "verification-infrastructure-failure",
  "probe-executor-failed": "verification-infrastructure-failure",
  "run-timeout": "verification-infrastructure-failure",
  "information-runtime-absent": "verification-infrastructure-failure",
});

const STAGE_BY_REASON: Readonly<
  Record<ChainVerificationFailureReason, ChainVerificationStage>
> = Object.freeze({
  "resource-unresolvable": "resolve",
  "resource-digest-mismatch": "resolve",
  "egress-succeeded": "isolate",
  "fork-backend-fetch-unrefused": "isolate",
  "uncommitted-resource-loaded": "compare",
  "out-of-slice-read-not-empty": "probe",
  "runtime-image-mismatch": "identify",
  "runtime-version-mismatch": "identify",
  "runtime-chain-id-mismatch": "identify",
  "determinism-control-unsupported": "identify",
  "anchor-block-mismatch": "provenance",
  "anchor-root-mismatch": "provenance",
  "state-proof-invalid": "provenance",
  "code-hash-mismatch": "provenance",
  "artifact-entry-uncovered": "provenance",
  "undeclared-source-mutation": "provenance",
  "post-fixture-commitment-mismatch": "instantiate",
  "fixture-transcript-mismatch": "instantiate",
  "rpc-allowlist-violation": "probe",
  "signer-scope-violation": "probe",
  "ceiling-not-enforced": "probe",
  "fixture-probe-failed": "probe",
  "origin-routing-collision": "probe",
  "request-key-divergence": "probe",
  "miss-policy-violation": "probe",
  "request-budget-not-enforced": "probe",
  "probe-observation-divergence": "compare",
  "reset-observation-divergence": "compare",
  "provider-observation-disagreement": "compare",
  "materializer-failed": "instantiate",
  "materialization-report-absent": "instantiate",
  "probe-executor-failed": "execute",
  "run-timeout": "execute",
  "information-runtime-absent": "resolve",
});

/** The four-way pipeline disposition, rewritten over this package's own vocabulary. */
export const CHAIN_VERIFICATION_DISPOSITIONS = [
  "terminal_policy",
  "awaiting_input",
  "quarantined",
  "failed_infrastructure",
] as const;
export type ChainVerificationDisposition =
  (typeof CHAIN_VERIFICATION_DISPOSITIONS)[number];

const DISPOSITION_BY_REASON: Readonly<
  Record<ChainVerificationFailureReason, ChainVerificationDisposition>
> = Object.freeze({
  // The store or the host was having a bad day; the same record may resolve later.
  "resource-unresolvable": "failed_infrastructure",
  "materializer-failed": "failed_infrastructure",
  "materialization-report-absent": "failed_infrastructure",
  "probe-executor-failed": "failed_infrastructure",
  "run-timeout": "failed_infrastructure",
  "information-runtime-absent": "failed_infrastructure",

  // The record names a digest that resolves to other bytes. Retrying the same record can only
  // reproduce it; the record itself must change.
  "resource-digest-mismatch": "terminal_policy",

  // The record makes a claim its own materials do not support. A corrected record is the only
  // thing that moves this forward.
  "runtime-image-mismatch": "awaiting_input",
  "runtime-version-mismatch": "awaiting_input",
  "runtime-chain-id-mismatch": "awaiting_input",
  "determinism-control-unsupported": "awaiting_input",
  "anchor-block-mismatch": "awaiting_input",
  "anchor-root-mismatch": "awaiting_input",
  "state-proof-invalid": "awaiting_input",
  "code-hash-mismatch": "awaiting_input",
  "artifact-entry-uncovered": "awaiting_input",
  "undeclared-source-mutation": "awaiting_input",
  "post-fixture-commitment-mismatch": "awaiting_input",
  "fixture-transcript-mismatch": "awaiting_input",

  // The world ran and behaved against its own declarations, or disagreed with itself. A
  // published fact, not a bug in the pipeline.
  "egress-succeeded": "quarantined",
  "fork-backend-fetch-unrefused": "quarantined",
  "uncommitted-resource-loaded": "quarantined",
  "out-of-slice-read-not-empty": "quarantined",
  "rpc-allowlist-violation": "quarantined",
  "signer-scope-violation": "quarantined",
  "ceiling-not-enforced": "quarantined",
  "fixture-probe-failed": "quarantined",
  "origin-routing-collision": "quarantined",
  "request-key-divergence": "quarantined",
  "miss-policy-violation": "quarantined",
  "request-budget-not-enforced": "quarantined",
  "probe-observation-divergence": "quarantined",
  "reset-observation-divergence": "quarantined",
  "provider-observation-disagreement": "quarantined",
});

export function outcomeForFailureReason(
  reason: ChainVerificationFailureReason,
): ChainVerificationOutcome {
  return OUTCOME_BY_REASON[reason];
}

export function stageForFailureReason(
  reason: ChainVerificationFailureReason,
): ChainVerificationStage {
  return STAGE_BY_REASON[reason];
}

export function classifyChainVerificationFailure(
  reason: ChainVerificationFailureReason,
): ChainVerificationDisposition {
  return DISPOSITION_BY_REASON[reason];
}
